/**
 * Unified Carrier Service API Endpoint
 *
 * This endpoint handles shipping rate requests from Shopify and calls
 * both Ingram and TechData APIs in parallel, then merges the results.
 *
 * Features:
 * - Verifies HMAC from Shopify carrier service requests
 * - Determines vendor for each SKU automatically
 * - Calls both Ingram and TechData APIs in parallel
 * - Merges rates by carrier code (combines prices for matching carriers)
 * - Handles fallback rates for each vendor
 * - Comprehensive logging for debugging
 */

import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";

// Ingram imports
import {
  requestFreightEstimate,
  prefetchIngramAuth,
  syncCarriersFromResponse,
  getCarrierConfigurations,
  getEnabledCarrierCodes,
  hasCarrierConfigurations,
  IngramError,
} from "../services/ingram.server";
import {
  getIngramMappingsForSkus,
  mappingArrayToRecord,
} from "../services/product-mapping.server";
import {
  combineRates,
  formatRateForShopify as formatIngramRateForShopify,
  type IngramDistribution,
} from "../services/rate-combiner.server";

// TechData imports
import {
  requestTd_FreightEstimate,
  getEnabledTd_CarrierCodes,
  getTd_CarrierConfigurations,
  hasTd_CarrierConfigurations,
  syncTd_CarriersFromResponse,
  Td_synnexError,
  type Td_RateTestInput,
} from "../services/tdsynnex.server";

// Shared imports
import { getVendor } from "../services/product-mapping.server";
import {
  getFallbackRateSettings,
  formatFallbackRateForShopify,
} from "../services/fallback-rate.server";
import { saveCarrierRateLog } from "../services/carrier-rate-log.server";

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

type ShopifyRate = {
  service_name: string;
  service_code: string;
  total_price: string;
  currency: string;
  description: string;
};

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
    const shipMethodRegex =
      /<AvailableShipMethod code="([^"]+)">\s*<ShipMethodDescription>([^<]+)<\/ShipMethodDescription>\s*<ServiceLevel>([^<]+)<\/ServiceLevel>\s*<Freight>([^<]+)<\/Freight>\s*<\/AvailableShipMethod>/g;

    let match;
    while ((match = shipMethodRegex.exec(xmlResponse)) !== null) {
      const [, code, description, , freight] = match;

      rates.push({
        name: description.trim(),
        code: code.trim(),
        price: parseFloat(freight.trim()),
        currency: "USD",
        description: description.trim(),
      });
    }

    return rates;
  } catch (error) {
    console.error("[UNIFIED][TECHDATA] Error parsing shipping rates:", error);
    return [];
  }
}

// Format TechData rate for Shopify carrier service response
function formatTechDataRateForShopify(
  rate: {
    name: string;
    code: string;
    price: number;
    currency: string;
    description: string;
  },
  currency: string,
  displayName?: string,
): ShopifyRate {
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

// Merge rates from both vendors by carrier code (INTERSECTION ONLY)
function mergeRatesByCode(
  ingramRates: ShopifyRate[] = [],
  techDataRates: ShopifyRate[] = [],
): ShopifyRate[] {
  const map = new Map<string, ShopifyRate>();

  // 1. Fill the map with Ingram rates first
  ingramRates.forEach((rate) => {
    map.set(rate.service_code, { ...rate });
  });

  const combinedResults: ShopifyRate[] = [];

  // 2. Only keep carriers that exist in BOTH vendors
  techDataRates.forEach((rate) => {
    if (map.has(rate.service_code)) {
      const existing = map.get(rate.service_code)!;

      // Sum the prices from both vendors
      const combinedPrice =
        parseInt(existing.total_price, 10) + parseInt(rate.total_price, 10);

      combinedResults.push({
        ...existing,
        total_price: combinedPrice.toString(),
        description: `${existing.description} (Combined)`,
      });

      // Remove from map to prevent duplicates
      map.delete(rate.service_code);
    }
  });

  return combinedResults;
}

// Get Ingram rates for items
async function getIngramRates(
  payload: RateRequestBody,
  ingramItems: Array<{ line: RateRequestLine; vendorInfo: any }>,
  correlationId: string,
  currency: string,
): Promise<ShopifyRate[] | null> {
  try {
    if (ingramItems.length === 0) {
      console.log(`[UNIFIED][${correlationId}] No Ingram items to process`);
      return null;
    }

    const uniqueSkus = Array.from(
      new Set(ingramItems.map((item) => item.line.sku)),
    );

    console.log(
      `[UNIFIED][INGRAM][${correlationId}] Processing ${ingramItems.length} Ingram items, SKUs: ${uniqueSkus.join(", ")}`,
    );

    // Map SKUs to Ingram part numbers
    const [mappings, auth] = await Promise.all([
      getIngramMappingsForSkus(payload.shopDomain, uniqueSkus, {
        allowSupabaseFallback: false,
      }),
      prefetchIngramAuth(payload.shopDomain),
    ]);

    const mappingRecord = mappingArrayToRecord(mappings);
    const missingSkus = uniqueSkus.filter((sku) => !mappingRecord[sku]);

    if (missingSkus.length > 0) {
      console.warn(
        `[UNIFIED][INGRAM][${correlationId}] Missing Ingram mappings for SKUs:`,
        missingSkus,
      );
      return null;
    }

    // Build ship-to address
    const shipToAddress = {
      companyName:
        payload.shipToAddress.companyName ||
        `${payload.shipToAddress.firstName ?? ""} ${payload.shipToAddress.lastName ?? ""}`.trim() ||
        "Shopify Customer",
      addressLine1: payload.shipToAddress.addressLine1,
      addressLine2: payload.shipToAddress.addressLine2 ?? undefined,
      city: payload.shipToAddress.city,
      state: payload.shipToAddress.state,
      postalCode: payload.shipToAddress.postalCode,
      countryCode: payload.shipToAddress.countryCode,
    };

    // Build lines for Ingram request
    const lines = ingramItems.map((item, index) => {
      const mapping = mappingRecord[item.line.sku];
      return {
        customerLineNumber: String(index + 1).padStart(3, "0"),
        ingramPartNumber: mapping.ingramPartNumber,
        quantity: String(item.line.quantity),
        carrierCode: "",
      };
    });

    console.log(
      `[UNIFIED][INGRAM][${correlationId}] Requesting freight estimate for ${lines.length} line items`,
    );

    const response = await requestFreightEstimate(
      payload.shopDomain,
      { shipToAddress, lines },
      { credentials: auth.credentials, accessToken: auth.accessToken },
    );

    const freightSummary = response.response?.freightEstimateResponse ?? {};
    const distributions: IngramDistribution[] =
      freightSummary?.distribution ?? [];

    console.log(
      `[UNIFIED][INGRAM][${correlationId}] Received ${distributions.length} distribution(s)`,
    );

    if (distributions.length === 0 || response.response?.errors) {
      console.warn(
        `[UNIFIED][INGRAM][${correlationId}] No distributions or API errors`,
      );
      return null;
    }

    // Sync carriers
    void syncCarriersFromResponse(payload.shopDomain, distributions).catch(
      (syncError) => {
        console.error(
          `[UNIFIED][INGRAM][${correlationId}] Failed to sync carriers:`,
          syncError,
        );
      },
    );

    // Combine rates across distributions
    const combinedRates = combineRates(distributions);
    console.log(
      `[UNIFIED][INGRAM][${correlationId}] Combined into ${combinedRates.length} unique carrier options`,
    );

    if (combinedRates.length === 0) {
      return null;
    }

    // Filter by enabled carriers if configured
    const hasConfigs = await hasCarrierConfigurations(payload.shopDomain);
    const carrierConfigs = await getCarrierConfigurations(payload.shopDomain);
    const configMap = new Map(carrierConfigs.map((c) => [c.carrierCode, c]));

    let shopifyRates;

    if (hasConfigs) {
      const enabledCodes = await getEnabledCarrierCodes(payload.shopDomain);
      shopifyRates = combinedRates
        .filter((rate) => enabledCodes.has(rate.carrierCode))
        .map((rate) => {
          const config = configMap.get(rate.carrierCode);
          return formatIngramRateForShopify(
            rate,
            currency,
            config?.displayName,
          );
        });
    } else {
      shopifyRates = combinedRates.map((rate) =>
        formatIngramRateForShopify(rate, currency),
      );
    }

    console.log(
      `[UNIFIED][INGRAM][${correlationId}] Returning ${shopifyRates.length} rates`,
    );
    return shopifyRates;
  } catch (error) {
    console.error(
      `[UNIFIED][INGRAM][${correlationId}] Error getting rates:`,
      error,
    );
    return null;
  }
}

// Get TechData rates for items
async function getTechDataRates(
  payload: RateRequestBody,
  techDataItems: Array<{ line: RateRequestLine; vendorInfo: any }>,
  correlationId: string,
  currency: string,
): Promise<ShopifyRate[] | null> {
  try {
    if (techDataItems.length === 0) {
      console.log(`[UNIFIED][${correlationId}] No TechData items to process`);
      return null;
    }

    const uniqueSkus = Array.from(
      new Set(techDataItems.map((item) => item.line.sku)),
    );

    console.log(
      `[UNIFIED][TECHDATA][${correlationId}] Processing ${techDataItems.length} TechData items, SKUs: ${uniqueSkus.join(", ")}`,
    );

    // Build ship-to address for TechData
    const shipToAddressData: Td_RateTestInput = {
      addressName1:
        payload.shipToAddress.companyName ||
        `${payload.shipToAddress.firstName ?? ""} ${payload.shipToAddress.lastName ?? ""}`.trim() ||
        "Shopify Customer",
      addressName2: undefined,
      addressLine1: payload.shipToAddress.addressLine1,
      city: payload.shipToAddress.city,
      state: payload.shipToAddress.state,
      zipCode: payload.shipToAddress.postalCode,
      country: payload.shipToAddress.countryCode,
      shipFromWarehouse: "03",
      Items: {
        Item: techDataItems.map((data) => ({
          itemSKU: data.vendorInfo.price_part_nbr,
          itemMfgPartNumber: data.vendorInfo.price_vendor_part,
          itemQuantity: String(data.line.quantity),
        })),
      },
    };

    console.log(
      `[UNIFIED][TECHDATA][${correlationId}] Requesting freight estimate for ${techDataItems.length} line items`,
    );

    const response = await requestTd_FreightEstimate(
      payload.shopDomain,
      shipToAddressData,
    );

    const xmlResponse = response.response as string;
    const rates = parseTechDataShippingRates(xmlResponse);

    console.log(
      `[UNIFIED][TECHDATA][${correlationId}] Parsed ${rates.length} shipping rates`,
    );

    if (
      rates.length === 0 ||
      xmlResponse.includes("<Error>") ||
      xmlResponse.includes("<error>")
    ) {
      console.warn(
        `[UNIFIED][TECHDATA][${correlationId}] No rates or API errors`,
      );
      return null;
    }

    // Sync carriers
    void syncTd_CarriersFromResponse(payload.shopDomain, rates).catch(
      (syncError) => {
        console.error(
          `[UNIFIED][TECHDATA][${correlationId}] Failed to sync carriers:`,
          syncError,
        );
      },
    );

    // Filter by enabled carriers if configured
    const hasConfigs = await hasTd_CarrierConfigurations(payload.shopDomain);
    const carrierConfigs = await getTd_CarrierConfigurations(
      payload.shopDomain,
    );
    const configMap = new Map(carrierConfigs.map((c) => [c.carrierCode, c]));

    let shopifyRates;

    if (hasConfigs) {
      const enabledCodes = await getEnabledTd_CarrierCodes(payload.shopDomain);

      shopifyRates = rates
        .filter((rate) => enabledCodes.has(rate.code))
        .map((rate) => {
          const config = configMap.get(rate.code);
          return formatTechDataRateForShopify(
            rate,
            currency,
            config?.displayName || undefined,
          );
        });
    } else {
      shopifyRates = rates.map((rate) =>
        formatTechDataRateForShopify(rate, currency),
      );
    }
 console.log("enabledCodes", shopifyRates);
    console.log(
      `[UNIFIED][TECHDATA][${correlationId}] Returning ${shopifyRates.length} rates`,
    );
    return shopifyRates;
  } catch (error) {
    console.error(
      `[UNIFIED][TECHDATA][${correlationId}] Error getting rates:`,
      error,
    );
    return null;
  }
}

// Get fallback rates for both vendors
async function getFallbackRates(
  shopDomain: string,
  currency: string,
): Promise<ShopifyRate[]> {
  const [ingramSettings, techDataSettings] = await Promise.all([
    getFallbackRateSettings(shopDomain, "INGRAM"),
    getFallbackRateSettings(shopDomain, "TECHDATA"),
  ]);

  const fallbackRates: ShopifyRate[] = [];

  if (ingramSettings.enabled) {
    fallbackRates.push(formatFallbackRateForShopify(ingramSettings, currency));
  }

  if (techDataSettings.enabled) {
    fallbackRates.push(
      formatFallbackRateForShopify(techDataSettings, currency),
    );
  }

  return fallbackRates;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const startTime = Date.now();
  const correlationId = crypto.randomUUID();
  const rawBody = await request.text();

  const carrierShop = isCarrierServiceRequest(request.headers);
  let payload: RateRequestBody | null = null;
  let carrierCurrency = "USD";

  console.log(
    `[UNIFIED][${correlationId}] Rate request received from: ${carrierShop || "direct"}`,
  );

  if (carrierShop) {
    try {
      verifyCarrierRequest(request.headers, rawBody);
    } catch (error) {
      console.error(
        `[UNIFIED][${correlationId}] Carrier request validation failed`,
        error,
      );
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const parsed = JSON.parse(rawBody);
      carrierCurrency = parsed?.rate?.currency ?? "USD";
      payload = carrierRequestToInternalPayload(carrierShop, parsed);
      console.log(
        `[UNIFIED][${correlationId}] Parsed ${payload.lines.length} cart items`,
      );
    } catch (error) {
      console.error(
        `[UNIFIED][${correlationId}] Invalid carrier request payload`,
        error,
      );
      return Response.json(
        { error: "Invalid carrier payload" },
        { status: 400 },
      );
    }
  } else {
    // Direct API call (for testing)
    const expectedToken = process.env.APP_BACKEND_TOKEN;
    if (expectedToken) {
      const provided = request.headers.get("X-App-Token");
      if (provided !== expectedToken) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    try {
      payload = JSON.parse(rawBody) as RateRequestBody;
    } catch (error) {
      console.error(
        `[UNIFIED][${correlationId}] Invalid JSON payload for rate route`,
        error,
      );
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
  }

  if (!payload || !isValidInternalPayload(payload)) {
    console.error(
      `[UNIFIED][${correlationId}] Missing or invalid payload data`,
    );
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

  console.log(
    `[UNIFIED][${correlationId}] Cart SKUs: ${uniqueSkus.join(", ")}`,
  );
  console.log(
    `[UNIFIED][${correlationId}] Ship to: ${payload.shipToAddress.city}, ${payload.shipToAddress.state} ${payload.shipToAddress.postalCode}`,
  );

  if (uniqueSkus.length === 0) {
    return Response.json({ error: "Lines missing SKU data" }, { status: 400 });
  }

  try {
    // Get vendor mappings to determine which items go to which vendor
    const vendor = await getVendor(uniqueSkus);
    const vendorMap = new Map(vendor.map((v) => [v.price_vendor_part, v]));

    // **VALIDATION: Check if all SKUs have vendor mappings**
    const unmappedSkus = uniqueSkus.filter((sku) => !vendorMap.has(sku));

    if (unmappedSkus.length > 0) {
      console.warn(
        `[UNIFIED][${correlationId}] No vendor mapping for SKUs: ${unmappedSkus.join(", ")}`,
      );

      // Save error log
      saveCarrierRateLog({
        carrierType: "UNIFIED",
        shopDomain: payload.shopDomain,
        correlationId,
        requestType: carrierShop ? "carrier_service" : "direct_api",
        cartItemCount: payload.lines.length,
        cartSkus: uniqueSkus,
        shipToCity: payload.shipToAddress.city,
        shipToState: payload.shipToAddress.state,
        shipToZip: payload.shipToAddress.postalCode,
        shipToCountry: payload.shipToAddress.countryCode,
        status: "error",
        errorMessage: `SKU(s) not found in vendor database: ${unmappedSkus.join(", ")}`,
        durationMs: Date.now() - startTime,
      });

      // Return error for BOTH carrier service AND direct API
      if (carrierShop) {
        // For Shopify, return empty rates array (Shopify handles this gracefully)
        return Response.json({ rates: [] }, { status: 200 });
      }

      return Response.json(
        {
          error: `SKU(s) not found in vendor database: ${unmappedSkus.join(", ")}`,
          invalidSkus: unmappedSkus,
        },
        { status: 422 },
      );
    }

    // Check which vendors we need to call
    const vendorTypes = vendor.map((data) => data.source_type);
    const hasIngram =
      vendorTypes.includes("INGRAM") || vendorTypes.includes("COMMON(INGRAM)");
    const hasTechData =
      vendorTypes.includes("TECHDATA") ||
      vendorTypes.includes("COMMON(TECHDATA)");

    console.log(
      `[UNIFIED][${correlationId}] Vendors needed: ${hasIngram ? "Ingram" : ""} ${hasTechData ? "TechData" : ""}`.trim(),
    );

    // Separate items by vendor
    const ingramItems = payload.lines
      .map((line) => ({
        line,
        vendorInfo: vendorMap.get(line.sku),
      }))
      .filter(
        (
          data,
        ): data is {
          line: RateRequestLine;
          vendorInfo: NonNullable<typeof data.vendorInfo>;
        } =>
          data.vendorInfo !== undefined &&
          (data.vendorInfo.source_type === "INGRAM" ||
            data.vendorInfo.source_type === "COMMON(INGRAM)"),
      );

    const techDataItems = payload.lines
      .map((line) => ({
        line,
        vendorInfo: vendorMap.get(line.sku),
      }))
      .filter(
        (
          data,
        ): data is {
          line: RateRequestLine;
          vendorInfo: NonNullable<typeof data.vendorInfo>;
        } =>
          data.vendorInfo !== undefined &&
          (data.vendorInfo.source_type === "TECHDATA" ||
            data.vendorInfo.source_type === "COMMON(TECHDATA)"),
      );

    console.log(
      `[UNIFIED][${correlationId}] Vendor split: ${ingramItems.length} Ingram, ${techDataItems.length} TechData`,
    );

    // Call both APIs in parallel
    const [ingramRates, techDataRates] = await Promise.all([
      hasIngram
        ? getIngramRates(payload, ingramItems, correlationId, carrierCurrency)
        : Promise.resolve(null),
      hasTechData
        ? getTechDataRates(
            payload,
            techDataItems,
            correlationId,
            carrierCurrency,
          )
        : Promise.resolve(null),
    ]);

    console.log(
      `[UNIFIED][${correlationId}] Ingram returned ${ingramRates?.length ?? 0} rates, TechData returned ${techDataRates?.length ?? 0} rates`,
    );

    // **KEY LOGIC: Check if required vendors failed to return rates**
    const isIngramMissing =
      hasIngram && (!ingramRates || ingramRates.length === 0);
    const isTechDataMissing =
      hasTechData && (!techDataRates || techDataRates.length === 0);

    console.log(
      `[UNIFIED][${correlationId}] Ingram missing: ${isIngramMissing}`,
    );
    console.log(
      `[UNIFIED][${correlationId}] TechData missing: ${isTechDataMissing}`,
    );

    // If ANY required vendor failed, return error
    if (isIngramMissing || isTechDataMissing) {
      const failedVendors = [];
      if (isIngramMissing) failedVendors.push("Ingram");
      if (isTechDataMissing) failedVendors.push("TechData");

      console.error(
        `[UNIFIED][${correlationId}] Shipping provider(s) ${failedVendors.join(", ")} failed to return rates`,
      );

      // Save error log
      saveCarrierRateLog({
        carrierType: "UNIFIED",
        shopDomain: payload.shopDomain,
        correlationId,
        requestType: carrierShop ? "carrier_service" : "direct_api",
        cartItemCount: payload.lines.length,
        cartSkus: uniqueSkus,
        shipToCity: payload.shipToAddress.city,
        shipToState: payload.shipToAddress.state,
        shipToZip: payload.shipToAddress.postalCode,
        shipToCountry: payload.shipToAddress.countryCode,
        status: "error",
        errorMessage: `Shipping provider(s) ${failedVendors.join(", ")} failed to return rates`,
        durationMs: Date.now() - startTime,
      });

      if (carrierShop) {
        const fallbackRates = await getFallbackRates(
          payload.shopDomain,
          carrierCurrency,
        );
        return Response.json({ rates: fallbackRates }, { status: 200 });
      }

      return Response.json(
        {
          error: `Shipping provider(s) ${failedVendors.join(", ")} failed to return rates. Cannot calculate total.`,
          failedVendors,
        },
        { status: 422 },
      );
    }

    // **LOGIC BRANCHING: Merge rates based on vendor configuration**
    let finalRates: ShopifyRate[] = [];

    if (hasIngram && hasTechData) {
      // BOTH vendors active: Merge rates by matching carrier codes and sum prices
      console.log(
        `[UNIFIED][${correlationId}] Merging rates from both vendors (intersection only)`,
      );

      finalRates = mergeRatesByCode(ingramRates!, techDataRates!);

      // Check if the intersection produced any results
      if (finalRates.length === 0) {
        console.warn(
          `[UNIFIED][${correlationId}] No matching shipping methods found between vendors`,
        );

        // Save error log
        saveCarrierRateLog({
          carrierType: "UNIFIED",
          shopDomain: payload.shopDomain,
          correlationId,
          requestType: carrierShop ? "carrier_service" : "direct_api",
          cartItemCount: payload.lines.length,
          cartSkus: uniqueSkus,
          shipToCity: payload.shipToAddress.city,
          shipToState: payload.shipToAddress.state,
          shipToZip: payload.shipToAddress.postalCode,
          shipToCountry: payload.shipToAddress.countryCode,
          status: "error",
          errorMessage: "No matching shipping methods found between vendors",
          durationMs: Date.now() - startTime,
        });

        if (carrierShop) {
          const fallbackRates = await getFallbackRates(
            payload.shopDomain,
            carrierCurrency,
          );
          return Response.json({ rates: fallbackRates }, { status: 200 });
        }

        return Response.json(
          { error: "No matching shipping methods found between vendors" },
          { status: 422 },
        );
      }
    } else if (hasIngram) {
      // ONLY Ingram active
      console.log(`[UNIFIED][${correlationId}] Using Ingram rates only`);
      finalRates = ingramRates!;
    } else if (hasTechData) {
      // ONLY TechData active
      console.log(`[UNIFIED][${correlationId}] Using TechData rates only`);
      finalRates = techDataRates!;
    }

    console.log(
      `[UNIFIED][${correlationId}] Final merged rates: ${finalRates.length}`,
    );

    // Sort by price (cheapest first) and limit options
    finalRates.sort(
      (a, b) => parseInt(a.total_price, 10) - parseInt(b.total_price, 10),
    );

    // const maxOptions = 10;
    // const limitedRates =
    //   finalRates.length > maxOptions
    //     ? finalRates.slice(0, maxOptions)
    //     : finalRates;

    console.log(
      `[UNIFIED][${correlationId}] Returning ${finalRates.length} rates to Shopify (took ${Date.now() - startTime}ms)`,
    );

    // Log successful request
    saveCarrierRateLog({
      carrierType: "UNIFIED",
      shopDomain: payload.shopDomain,
      correlationId,
      requestType: carrierShop ? "carrier_service" : "direct_api",
      cartItemCount: payload.lines.length,
      cartSkus: uniqueSkus,
      shipToCity: payload.shipToAddress.city,
      shipToState: payload.shipToAddress.state,
      shipToZip: payload.shipToAddress.postalCode,
      shipToCountry: payload.shipToAddress.countryCode,
      status: "success",
      carriersCount: finalRates.length,
      ratesReturned: finalRates.length,
      ratesData: finalRates,
      durationMs: Date.now() - startTime,
    });

    return Response.json({ rates: finalRates }, { status: 200 });
  } catch (error) {
    console.error(
      `[UNIFIED][${correlationId}] Failed to retrieve freight estimate`,
      error,
    );

    const errorDetails =
      error instanceof IngramError || error instanceof Td_synnexError
        ? {
            status: (error as any).status,
            details: (error as any).details,
            stack: error.stack,
          }
        : error instanceof Error
          ? { stack: error.stack }
          : error;

    saveCarrierRateLog({
      carrierType: "UNIFIED",
      shopDomain: payload.shopDomain,
      correlationId,
      requestType: carrierShop ? "carrier_service" : "direct_api",
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
      const fallbackRates = await getFallbackRates(
        payload.shopDomain,
        carrierCurrency,
      );
      return Response.json({ rates: fallbackRates }, { status: 200 });
    }

    return Response.json(
      { error: "Unable to retrieve freight estimate" },
      { status: 500 },
    );
  }
};
