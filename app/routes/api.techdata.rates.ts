import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";

import {
  requestTd_FreightEstimate,
  getEnabledTd_CarrierCodes,
  getTd_CarrierConfigurations,
  hasTd_CarrierConfigurations,
  syncTd_CarriersFromResponse,
  Td_synnexError,
  td_getCredentials,
  type Td_RateTestInput,
} from "../services/tdsynnex.server";
import {
  getVendor,
} from "../services/product-mapping.server";
import {
  getFallbackRateSettings,
  formatFallbackRateForShopify,
} from "../services/fallback-rate.server";
import {
  saveCarrierRateLog,
} from "../services/carrier-rate-log.server";

// Helper to get fallback rate response for carrier service (TechData-specific)
async function getFallbackRateResponse(
  shopDomain: string,
  currency: string = "USD"
): Promise<{ rates: Array<ReturnType<typeof formatFallbackRateForShopify>> }> {
  const settings = await getFallbackRateSettings(shopDomain, "TECHDATA");

  if (!settings.enabled) {
    return { rates: [] };
  }

  const fallbackRate = formatFallbackRateForShopify(settings, currency);
  return { rates: [fallbackRate] };
}

type RateRequestLine = {
  sku: string;
  quantity: number;
  title?: string;
  weight?: number;
  weightUnit?: "g" | "kg" | "lb";
  metadata?: Record<string, unknown>;
};

type RateRequestBody = {
  shopDomain: string;
  shipToAddress: {
    companyName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    addressLine1: string;
    addressLine2?: string | null;
    city: string;
    state: string;
    postalCode: string;
    countryCode: string;
  };
  lines: RateRequestLine[];
};

function normalizeShipToAddress(body: RateRequestBody): Td_RateTestInput {
  const { shipToAddress } = body;
  const company =
    shipToAddress.companyName ||
    `${shipToAddress.firstName ?? ""} ${shipToAddress.lastName ?? ""}`.trim() ||
    "Shopify Customer";

  return {
    addressName1: company,
    addressName2: undefined,
    addressLine1: shipToAddress.addressLine1,
    city: shipToAddress.city,
    state: shipToAddress.state,
    zipCode: shipToAddress.postalCode,
    country: shipToAddress.countryCode,
    shipFromWarehouse: "03", // Default warehouse
    Items: {
      Item: [],
    },
  };
}

function isCarrierServiceRequest(headers: Headers) {
  return headers.get("X-Shopify-Shop-Domain");
}

function verifyCarrierRequest(headers: Headers, rawBody: string) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_API_SECRET missing for HMAC validation");
  }

  const hmac = headers.get("X-Shopify-Hmac-Sha256");
  if (!hmac) {
    throw new Error("Missing Shopify HMAC header");
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
    throw new Error("Invalid Shopify HMAC");
  }
}

function carrierRequestToInternalPayload(
  shopDomain: string,
  body: any,
): RateRequestBody {
  const destination = body?.rate?.destination || {};
  const items = Array.isArray(body?.rate?.items) ? body.rate.items : [];

  const lines: RateRequestLine[] = items.map((item: any) => ({
    sku: item.sku || item.product_id || item.title || item.name,
    quantity: item.quantity ?? 1,
    title: item.name,
    weight: item.grams,
    weightUnit: "g",
  }));

  return {
    shopDomain,
    shipToAddress: {
      companyName: destination.company,
      firstName: destination.name,
      lastName: destination.last_name,
      addressLine1: destination.address1,
      addressLine2: destination.address2,
      city: destination.city,
      state: destination.province || destination.province_code || "",
      postalCode: destination.postal_code || "",
      countryCode: destination.country_code || destination.country || "",
    },
    lines,
  };
}

function isValidInternalPayload(payload: RateRequestBody) {
  return (
    payload.shopDomain &&
    payload.shipToAddress?.addressLine1 &&
    payload.shipToAddress?.city &&
    payload.shipToAddress?.state &&
    payload.shipToAddress?.postalCode &&
    payload.shipToAddress?.countryCode &&
    payload.lines?.length > 0
  );
}


// Parse TD SYNNEX XML response and extract shipping rates
function parseTechDataShippingRates(xmlResponse: string) {
  const rates: Array<{
    name: string;
    code: string;
    price: number;
    currency: string;
    description: string;
  }> = [];

  try {
    // Match all AvailableShipMethod blocks in the XML
    const shipMethodRegex =
      /<AvailableShipMethod code="([^"]+)">\s*<ShipMethodDescription>([^<]+)<\/ShipMethodDescription>\s*<ServiceLevel>([^<]+)<\/ServiceLevel>\s*<Freight>([^<]+)<\/Freight>\s*<\/AvailableShipMethod>/g;

    let match;
    while ((match = shipMethodRegex.exec(xmlResponse)) !== null) {
      const [, code, description, , freight] = match;

      rates.push({
        name: description.trim(),
        code: code.trim(),
        price: parseFloat(freight.trim()),
        currency: "USD", // TD SYNNEX uses USD by default
        description: description.trim(),
      });
    }

    return rates;
  } catch (error) {
    console.error("[TECHDATA] Error parsing shipping rates:", error);
    return [];
  }
}

// Format rate for Shopify carrier service response
function formatRateForShopify(
  rate: {
    name: string;
    code: string;
    price: number;
    currency: string;
    description: string;
  },
  currency: string,
  displayName?: string,
) {
  const serviceName = displayName || rate.name;
  const priceInCents = Math.round(rate.price * 100);

  return {
    service_name: serviceName,
    service_code: rate.code,
    total_price: priceInCents.toString(),
    currency,
    description: rate.description,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const startTime = Date.now();
  const correlationId = crypto.randomUUID();
  const rawBody = await request.text();

  const carrierShop = isCarrierServiceRequest(request.headers);
  let payload: RateRequestBody | null = null;
  let carrierCurrency = "USD";
  const expectedToken = process.env.APP_BACKEND_TOKEN;

  console.log(`[TECHDATA][${correlationId}] Rate request received from: ${carrierShop || "direct"}`);

  // Log raw request for debugging (truncated to avoid huge logs)
  if (carrierShop) {
    try {
      const parsedRaw = JSON.parse(rawBody);
      const itemCount = parsedRaw?.rate?.items?.length ?? 0;
      const itemSkus = (parsedRaw?.rate?.items ?? []).map((i: any) => i.sku || i.name || "no-sku").join(", ");
      console.log(`[TECHDATA][${correlationId}] Raw Shopify request: ${itemCount} items, SKUs: [${itemSkus}]`);
    } catch {
      console.log(`[TECHDATA][${correlationId}] Raw body (first 500 chars): ${rawBody.slice(0, 500)}`);
    }
  }

  if (carrierShop) {
    try {
      verifyCarrierRequest(request.headers, rawBody);
    } catch (error) {
      console.error(`[TECHDATA][${correlationId}] Carrier request validation failed`, error);
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const parsed = JSON.parse(rawBody);
      carrierCurrency = parsed?.rate?.currency ?? "USD";
      payload = carrierRequestToInternalPayload(carrierShop, parsed);
      console.log(`[TECHDATA][${correlationId}] Parsed ${payload.lines.length} cart items`);
    } catch (error) {
      console.error(`[TECHDATA][${correlationId}] Invalid carrier request payload`, error);
      return Response.json(
        { error: "Invalid carrier payload" },
        { status: 400 },
      );
    }
  } else {
    if (expectedToken) {
      const provided = request.headers.get("X-App-Token");
      if (provided !== expectedToken) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    try {
      payload = JSON.parse(rawBody) as RateRequestBody;
    } catch (error) {
      console.error(`[TECHDATA][${correlationId}] Invalid JSON payload for rate route`, error);
      return Response.json(
        { error: "Invalid JSON payload" },
        { status: 400 },
      );
    }
  }

  if (!payload || !isValidInternalPayload(payload)) {
    console.error(`[TECHDATA][${correlationId}] Missing or invalid payload data`);
    return Response.json(
      { error: "Missing or invalid payload data" },
      { status: 400 },
    );
  }

  const uniqueSkus = Array.from(
    new Set(
      payload.lines
        .map((line) => line.sku?.trim())
        .filter((sku): sku is string => Boolean(sku)),
    ),
  );

  console.log(`[TECHDATA][${correlationId}] Cart SKUs: ${uniqueSkus.join(", ")}`);
  console.log(`[TECHDATA][${correlationId}] Ship to: ${payload.shipToAddress.city}, ${payload.shipToAddress.state} ${payload.shipToAddress.postalCode}`);

  if (uniqueSkus.length === 0) {
    return Response.json({ error: "Lines missing SKU data" }, { status: 400 });
  }

  try {
    // Get vendor mapping to verify these are TechData items
    const mappingStart = Date.now();
    const vendor = await getVendor(uniqueSkus);
    console.log(`[TECHDATA][${correlationId}] SKU vendor lookup took ${Date.now() - mappingStart}ms`);

    // Create a map of SKU to vendor info
    const vendorMap = new Map(vendor.map((v) => [v.price_vendor_part, v]));

    // Filter for TechData items only
    const techDataItems = payload.lines
      .map((line) => ({
        line,
        vendorInfo: vendorMap.get(line.sku),
      }))
      .filter(
        (data): data is {
          line: typeof data.line;
          vendorInfo: NonNullable<typeof data.vendorInfo>;
        } =>
          data.vendorInfo !== undefined &&
          data.vendorInfo.source_type === "TECHDATA",
      );

    console.log(`[TECHDATA][${correlationId}] Vendor mapping results: ${techDataItems.length}/${uniqueSkus.length} mapped to TechData`);

    const missingSkus = uniqueSkus.filter((sku) => !vendorMap.get(sku) || vendorMap.get(sku)?.source_type !== "TECHDATA");
    if (missingSkus.length > 0) {
      console.warn(`[TECHDATA][${correlationId}] Missing TechData mappings for SKUs:`, missingSkus);

      // Log this as no_mapping
      saveCarrierRateLog({
        carrierType: "TECHDATA",
        shopDomain: payload.shopDomain,
        correlationId,
        requestType: carrierShop ? "carrier_service" : "cart_estimate",
        cartItemCount: payload.lines.length,
        cartSkus: uniqueSkus,
        shipToCity: payload.shipToAddress.city,
        shipToState: payload.shipToAddress.state,
        shipToZip: payload.shipToAddress.postalCode,
        shipToCountry: payload.shipToAddress.countryCode,
        status: "no_mapping",
        errorMessage: `Missing TechData mappings for: ${missingSkus.join(", ")}`,
        durationMs: Date.now() - startTime,
      });

      // For carrier service, return fallback rate if configured
      if (carrierShop) {
        const fallbackResponse = await getFallbackRateResponse(payload.shopDomain, carrierCurrency);
        return Response.json(fallbackResponse, { status: 200 });
      }
      return Response.json(
        {
          error: "Missing TechData mapping for the provided SKUs",
          missingSkus,
        },
        { status: 422 },
      );
    }

    if (techDataItems.length === 0) {
      console.warn(`[TECHDATA][${correlationId}] No TechData items found in cart`);

      saveCarrierRateLog({
        carrierType: "TECHDATA",
        shopDomain: payload.shopDomain,
        correlationId,
        requestType: carrierShop ? "carrier_service" : "cart_estimate",
        cartItemCount: payload.lines.length,
        cartSkus: uniqueSkus,
        shipToCity: payload.shipToAddress.city,
        shipToState: payload.shipToAddress.state,
        shipToZip: payload.shipToAddress.postalCode,
        shipToCountry: payload.shipToAddress.countryCode,
        status: "no_mapping",
        errorMessage: "No TechData items in cart",
        durationMs: Date.now() - startTime,
      });

      if (carrierShop) {
        const fallbackResponse = await getFallbackRateResponse(payload.shopDomain, carrierCurrency);
        return Response.json(fallbackResponse, { status: 200 });
      }
      return Response.json(
        { error: "No TechData items found" },
        { status: 422 },
      );
    }

    const shipToAddressData = normalizeShipToAddress(payload);

    // Build request payload for TechData
    const techDataPayload: Td_RateTestInput = {
      ...shipToAddressData,
      Items: {
        Item: techDataItems.map((data) => ({
          itemSKU: data.vendorInfo.price_part_nbr,
          itemMfgPartNumber: data.vendorInfo.price_vendor_part,
          itemQuantity: String(data.line.quantity),
        })),
      },
    };

    const tdPartNums = techDataItems.map(d => d.vendorInfo.price_part_nbr);
    console.log(`[TECHDATA][${correlationId}] Requesting freight estimate for ${techDataItems.length} line items`);
    console.log(`[TECHDATA][${correlationId}] TechData part numbers: ${tdPartNums.join(", ")}`);

    const techDataStart = Date.now();
    const response = await requestTd_FreightEstimate(
      payload.shopDomain,
      techDataPayload,
    );
    console.log(
      `[TECHDATA][${correlationId}] TechData freight ${response.cacheHit ? "cache hit" : "API call"} completed in ${Date.now() - techDataStart}ms`,
    );

    if (carrierShop) {
      const xmlResponse = response.response as string;

      // Parse XML response
      const rates = parseTechDataShippingRates(xmlResponse);

      console.log(`[TECHDATA][${correlationId}] Parsed ${rates.length} shipping rates from XML`);

      // Log rate details
      if (rates.length > 0) {
        console.log(`[TECHDATA][${correlationId}] Rates:`, rates.map(r =>
          `${r.code}: $${r.price.toFixed(2)}`
        ).join(", "));
      } else {
        console.warn(`[TECHDATA][${correlationId}] No rates found in TechData response!`);
      }

      // Check for API errors in XML
      if (xmlResponse.includes("<Error>") || xmlResponse.includes("<error>")) {
        console.error(`[TECHDATA][${correlationId}] TechData API errors found in response`);

        saveCarrierRateLog({
          carrierType: "TECHDATA",
          shopDomain: payload.shopDomain,
          correlationId,
          requestType: "carrier_service",
          cartItemCount: payload.lines.length,
          cartSkus: uniqueSkus,
          vendorPartNums: tdPartNums,
          shipToCity: payload.shipToAddress.city,
          shipToState: payload.shipToAddress.state,
          shipToZip: payload.shipToAddress.postalCode,
          shipToCountry: payload.shipToAddress.countryCode,
          status: "api_error",
          errorMessage: "TechData API returned errors",
          vendorRawResponse: xmlResponse,
          durationMs: Date.now() - startTime,
        });

        const fallbackResponse = await getFallbackRateResponse(payload.shopDomain, carrierCurrency);
        return Response.json(fallbackResponse, { status: 200 });
      }

      // Sync available carriers to database (for admin configuration)
      if (rates.length > 0) {
        void syncTd_CarriersFromResponse(payload.shopDomain, rates).catch((syncError) => {
          console.error(`[TECHDATA][${correlationId}] Failed to sync carriers:`, syncError);
        });
      }

      if (rates.length === 0) {
        // No rates available - return fallback rate if configured
        saveCarrierRateLog({
          carrierType: "TECHDATA",
          shopDomain: payload.shopDomain,
          correlationId,
          requestType: "carrier_service",
          cartItemCount: payload.lines.length,
          cartSkus: uniqueSkus,
          vendorPartNums: tdPartNums,
          shipToCity: payload.shipToAddress.city,
          shipToState: payload.shipToAddress.state,
          shipToZip: payload.shipToAddress.postalCode,
          shipToCountry: payload.shipToAddress.countryCode,
          status: "no_rates",
          carriersCount: 0,
          ratesReturned: 0,
          errorMessage: "No shipping rates returned from TechData",
          vendorRawResponse: xmlResponse,
          durationMs: Date.now() - startTime,
        });

        // Return fallback rate if configured
        const fallbackResponse = await getFallbackRateResponse(payload.shopDomain, carrierCurrency);
        return Response.json(fallbackResponse, { status: 200 });
      }

      // Check if carrier configurations exist for filtering
      const hasConfigs = await hasTd_CarrierConfigurations(payload.shopDomain);
      const carrierConfigs = await getTd_CarrierConfigurations(payload.shopDomain);
      const configMap = new Map(carrierConfigs.map((c) => [c.carrierCode, c]));

      let shopifyRates;

      if (hasConfigs) {
        const enabledCodes = await getEnabledTd_CarrierCodes(payload.shopDomain);
        console.log(`[TECHDATA][${correlationId}] Enabled carrier codes: ${Array.from(enabledCodes).join(", ")}`);

        shopifyRates = rates
          .filter(rate => enabledCodes.has(rate.code))
          .map(rate => {
            const config = configMap.get(rate.code);
            return formatRateForShopify(rate, carrierCurrency, config?.displayName || undefined);
          });

        console.log(`[TECHDATA][${correlationId}] Filtered to ${shopifyRates.length} enabled carriers`);
      } else {
        // No configuration yet - show all available carriers
        shopifyRates = rates.map(rate =>
          formatRateForShopify(rate, carrierCurrency)
        );
        console.log(`[TECHDATA][${correlationId}] No carrier config, showing all ${shopifyRates.length} carriers`);
      }

      // Sort by price (cheapest first) and limit to reasonable number
      shopifyRates.sort((a, b) =>
        parseInt(a.total_price, 10) - parseInt(b.total_price, 10)
      );

      // Optionally limit to top N options to avoid overwhelming checkout
      // const maxOptions = 10;
      // if (shopifyRates.length > maxOptions) {
      //   shopifyRates = shopifyRates.slice(0, maxOptions);
      // }

      console.log(`[TECHDATA][${correlationId}] Returning ${shopifyRates.length} rates to Shopify`);

      // Log successful request
      saveCarrierRateLog({
        carrierType: "TECHDATA",
        shopDomain: payload.shopDomain,
        correlationId,
        requestType: "carrier_service",
        cartItemCount: payload.lines.length,
        cartSkus: uniqueSkus,
        vendorPartNums: tdPartNums,
        shipToCity: payload.shipToAddress.city,
        shipToState: payload.shipToAddress.state,
        shipToZip: payload.shipToAddress.postalCode,
        shipToCountry: payload.shipToAddress.countryCode,
        status: "success",
        carriersCount: rates.length,
        ratesReturned: shopifyRates.length,
        ratesData: shopifyRates,
        vendorRawResponse: xmlResponse,
        durationMs: Date.now() - startTime,
      });

      return Response.json({ rates: shopifyRates }, { status: 200 });
    }

    // Non-carrier request - return full response for testing/debugging
    return Response.json(
      {
        success: true,
        data: response.response,
        correlationId,
        lineCount: techDataItems.length,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error(`[TECHDATA][${correlationId}] Failed to retrieve freight estimate`, error);

    // Log error
    const errorDetails =
      error instanceof Td_synnexError
        ? {
            status: error.status,
            details: error.details,
            stack: error.stack,
          }
        : error instanceof Error
          ? { stack: error.stack }
          : error;

    saveCarrierRateLog({
      carrierType: "TECHDATA",
      shopDomain: payload.shopDomain,
      correlationId,
      requestType: carrierShop ? "carrier_service" : "cart_estimate",
      cartItemCount: payload.lines.length,
      cartSkus: uniqueSkus,
      shipToCity: payload.shipToAddress.city,
      shipToState: payload.shipToAddress.state,
      shipToZip: payload.shipToAddress.postalCode,
      shipToCountry: payload.shipToAddress.countryCode,
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      errorDetails,
      durationMs: Date.now() - startTime,
    });

    if (carrierShop) {
      const fallbackResponse = await getFallbackRateResponse(payload.shopDomain, carrierCurrency);
      return Response.json(fallbackResponse, { status: 200 });
    }

    return Response.json(
      {
        error: "Unable to retrieve freight estimate",
      },
      { status: 500 },
    );
  }
};
