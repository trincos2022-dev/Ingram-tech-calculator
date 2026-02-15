/**
 * Cart Estimate API Endpoint
 *
 * This endpoint provides shipping estimates for the cart page before checkout.
 * It can be called directly from the theme's JavaScript to show estimated
 * shipping costs based on the customer's address.
 *
 * Unlike the carrier service endpoint, this one:
 * - Accepts CORS requests from the storefront
 * - Returns a simplified response format
 * - Doesn't require HMAC verification (public endpoint)
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  requestFreightEstimate,
  getEnabledCarrierCodes,
  hasCarrierConfigurations,
  getCarrierConfigurations,
  getCredentials,
  syncCarriersFromResponse,
} from "../services/ingram.server";
import {
  getIngramMappingsForSkus,
  getVendor,
  mappingArrayToRecord,
} from "../services/product-mapping.server";
import {
  combineRates,
  formatRateForShopify,
  type IngramDistribution,
} from "../services/rate-combiner.server";
import {
  getEnabledTd_CarrierCodes,
  hasTd_CarrierConfigurations,
  requestTd_FreightEstimate,
  syncTd_CarriersFromResponse,
  td_getCredentials,
} from "app/services/tdsynnex.server";

type CartEstimateRequest = {
  shop: string;
  address: {
    country: string;
    province?: string;
    city?: string;
    zip?: string;
  };
  items: Array<{
    sku: string;
    quantity: number;
    grams?: number;
  }>;
};

type CartEstimateResponse = {
  success: boolean;
  rates?: Array<{
    name: string;
    code: string;
    price: number;
    currency: string;
    description: string;
  }>;
  error?: string;
};

// CORS headers for storefront requests
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Shop-Domain",
};

// Handle OPTIONS preflight
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // GET requests not supported for this endpoint
  return Response.json(
    { success: false, error: "Use POST to request cart estimates" },
    { status: 405, headers: corsHeaders },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("data request", request);

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    const body: CartEstimateRequest = await request.json();
    const skus = body.items.map((item) => item.sku);
    const vendor = await getVendor(skus);

    // Create a map of SKU to vendor info for correct matching
    const vendorMap = new Map(vendor.map((v) => [v.price_vendor_part, v]));

    // **VALIDATION: Check if all items have vendor info**
    const itemsWithoutVendor = body.items.filter(
      (item) => !vendorMap.has(item.sku),
    );

    if (itemsWithoutVendor.length > 0) {
      const invalidSkus = itemsWithoutVendor.map((item) => item.sku);
      return Response.json(
        {
          success: false,
          error: `SKU(s) not found in vendor database: ${invalidSkus.join(", ")}`,
        } as CartEstimateResponse,
        { status: 400, headers: corsHeaders },
      );
    }

    const vendortype = vendor.map((data) => data.source_type);
    console.log("items", vendortype);

    // Check which vendors we need to call
    const hasIngram =
      vendortype.includes("INGRAM") || vendortype.includes("COMMON(INGRAM)");
    const hasTechData =
      vendortype.includes("TECHDATA") ||
      vendortype.includes("COMMON(TECHDATA)");

    // Group items by vendor type with vendor info, matching by SKU not index
    const ingramItems = body.items
      .map((item) => ({
        item,
        vendorInfo: vendorMap.get(item.sku),
      }))
      .filter(
        (
          data,
        ): data is {
          item: typeof data.item;
          vendorInfo: NonNullable<typeof data.vendorInfo>;
        } =>
          data.vendorInfo !== undefined &&
          (data.vendorInfo.source_type === "INGRAM" ||
            data.vendorInfo.source_type === "COMMON(INGRAM)"),
      );

    const techDataItems = body.items
      .map((item) => ({
        item,
        vendorInfo: vendorMap.get(item.sku),
      }))
      .filter(
        (
          data,
        ): data is {
          item: typeof data.item;
          vendorInfo: NonNullable<typeof data.vendorInfo>;
        } =>
          data.vendorInfo !== undefined &&
          (data.vendorInfo.source_type === "TECHDATA" ||
            data.vendorInfo.source_type === "COMMON(TECHDATA)"),
      );

    // Call both APIs in parallel
    const [ingramRates, techDataRates] = await Promise.all([
      hasIngram ? getIngramRates(body, ingramItems) : Promise.resolve(null),
      hasTechData
        ? getTechDataRates(body, techDataItems)
        : Promise.resolve(null),
    ]);

    console.log("ingramItems", ingramRates);
    console.log("techDataItems", techDataRates);

    // Combine rates from both vendors
    // const allRates = [...(ingramRates || []), ...(techDataRates || [])];
    // 1. Check if any active request returned an empty result or null

    //rate compinor for both vendors
    type Rate = {
      code: string;
      price: number;
      [key: string]: any;
    };

    const mergeRatesByCode = (
      ingramRates: Rate[] = [],
      techDataRates: Rate[] = [],
    ): Rate[] => {
      const map = new Map<string, Rate>();

      // 1. Fill the map with Ingram rates first
      ingramRates.forEach((rate) => {
        map.set(rate.code, { ...rate });
      });

      const combinedResults: Rate[] = [];

      // 2. Only keep items that exist in BOTH
      techDataRates.forEach((rate) => {
        if (map.has(rate.code)) {
          const existing = map.get(rate.code)!;

          combinedResults.push({
            ...existing,
            // Sum the prices
            price: (existing.price || 0) + (rate.price || 0),
          });

          // Optional: Remove from map to ensure we don't process it again
          // if techDataRates has duplicates
          map.delete(rate.code);
        }
      });

      return combinedResults;
    };

    // **KEY CHANGE**: Check if a vendor was NEEDED but FAILED
    const isIngramMissing =
      hasIngram && (!ingramRates || ingramRates.length === 0);
    const isTechDataMissing =
      hasTechData && (!techDataRates || techDataRates.length === 0);

    console.log("Ingram missing:", isIngramMissing);
    console.log("TechData missing:", isTechDataMissing);

    // If ANY required vendor failed, return error
    if (isIngramMissing || isTechDataMissing) {
      const failedVendors = [];
      if (isIngramMissing) failedVendors.push("Ingram");
      if (isTechDataMissing) failedVendors.push("TechData");

      return Response.json(
        {
          success: false,
          error: `Shipping provider(s) ${failedVendors.join(", ")} failed to return rates. Cannot calculate total.`,
        } as CartEstimateResponse,
        { status: 200, headers: corsHeaders },
      );
    }

    // Logic Branching
    let finalRates: Rate[] = [];

    if (hasIngram && hasTechData) {
      // BOTH active: Use the merge/sum function
      finalRates = mergeRatesByCode(ingramRates!, techDataRates!);

      // Check if the intersection actually produced results
      if (finalRates.length === 0) {
        return Response.json(
          {
            success: false,
            error: "No matching shipping methods found between vendors",
          },
          { status: 200, headers: corsHeaders },
        );
      }
    } else if (hasIngram) {
      // ONLY Ingram active
      finalRates = ingramRates!;
    } else if (hasTechData) {
      // ONLY TechData active
      finalRates = techDataRates!;
    }

    return Response.json(
      { success: true, finalRates } as CartEstimateResponse,
      { status: 200, headers: corsHeaders },
    );
  } catch (error) {
    console.error("Cart estimate error:", error);
    return Response.json(
      {
        success: false,
        error: "Unable to calculate shipping estimate",
      } as CartEstimateResponse,
      { status: 200, headers: corsHeaders },
    );
  }
};

// Extract INGRAM rate logic into a separate function
async function getIngramRates(
  body: CartEstimateRequest,
  itemsWithVendor: Array<{
    item: CartEstimateRequest["items"][0];
    vendorInfo: {
      price_vendor_part: string;
      price_part_nbr: string;
      source_type: string;
    };
  }>,
) {
  try {
    if (itemsWithVendor.length === 0) return null;

    // Validate required fields
    if (!body.shop) {
      throw new Error("Missing shop domain");
    }

    if (!body.address || !body.address.country) {
      throw new Error("Missing address information");
    }

    // Check if credentials exist for this shop
    const credentials = await getCredentials(body.shop);
    if (!credentials) {
      throw new Error("Shop not configured");
    }

    // Get unique SKUs from items parameter
    const uniqueSkus = Array.from(
      new Set(
        itemsWithVendor
          .map((data) => data.item.sku?.trim())
          .filter((sku): sku is string => Boolean(sku)),
      ),
    );

    if (uniqueSkus.length === 0) {
      return null;
    }

    // Map SKUs to Ingram part numbers
    const mappings = await getIngramMappingsForSkus(body.shop, uniqueSkus, {
      allowSupabaseFallback: false,
    });
    const mappingRecord = mappingArrayToRecord(mappings);

    const missingSkus = uniqueSkus.filter((sku) => !mappingRecord[sku]);
    if (missingSkus.length > 0) {
      console.warn(
        "Cart estimate (INGRAM): Missing Ingram mappings for SKUs:",
        missingSkus,
      );
      return null;
    }

    // Build ship-to address
    const shipToAddress = {
      companyName: "Customer",
      addressLine1: body.address.city || "Unknown",
      city: body.address.city || "Unknown",
      state: body.address.province || body.address.country,
      postalCode: body.address.zip || "00000",
      countryCode: body.address.country,
    };

    // Build lines for Ingram request using vendor part numbers
    const lines = itemsWithVendor.map((data, index) => {
      const mapping = mappingRecord[data.item.sku];
      return {
        customerLineNumber: String(index + 1).padStart(3, "0"),
        ingramPartNumber: mapping.ingramPartNumber,
        quantity: String(data.item.quantity),
        carrierCode: "",
      };
    });

    console.log(
      `[INGRAM] Cart estimate: Requesting for ${lines.length} items to ${shipToAddress.postalCode}`,
    );

    // Request freight estimate from Ingram
    const response = await requestFreightEstimate(body.shop, {
      shipToAddress,
      lines,
    });

    const freightSummary = response.response?.freightEstimateResponse ?? {};
    const currency = freightSummary.currencyCode || "USD";
    const distributions: IngramDistribution[] =
      freightSummary?.distribution ?? [];

    if (distributions.length === 0) {
      return null;
    }

    // Sync available carriers to database (for admin configuration)
    console.log(
      `[INGRAM] Syncing ${distributions.length} distributions to carrier configs`,
    );
    void syncCarriersFromResponse(body.shop, distributions).catch(
      (syncError) => {
        console.error("[INGRAM] Failed to sync carriers to DB:", syncError);
      },
    );

    // Combine rates across distributions
    const combinedRates = combineRates(distributions);

    if (combinedRates.length === 0) {
      console.warn("[INGRAM] No combined rates after processing distributions");
      return null;
    }

    console.log(
      `[INGRAM] Combined ${combinedRates.length} rates from distributions`,
    );

    // Check if carrier configurations exist for filtering
    const hasConfigs = await hasCarrierConfigurations(body.shop);

    let filteredRates = combinedRates;

    if (hasConfigs) {
      const enabledCodes = await getEnabledCarrierCodes(body.shop);
      console.log(
        `[INGRAM] Filtering rates by ${enabledCodes.size} enabled carriers`,
      );

      filteredRates = combinedRates.filter((rate) =>
        enabledCodes.has(rate.carrierCode),
      );

      console.log(
        `[INGRAM] ${filteredRates.length} rates remaining after filtering`,
      );

      // If all rates were filtered out, return null
      if (filteredRates.length === 0) {
        console.warn(
          "[INGRAM] All rates filtered out by carrier configuration",
        );
        return null;
      }
    }

    // Get carrier configs for display names
    const carrierConfigs = await getCarrierConfigurations(body.shop);
    const configMap = new Map(carrierConfigs.map((c) => [c.carrierCode, c]));

    // Format rates for response
    const rates = filteredRates.map((rate) => {
      const config = configMap.get(rate.carrierCode);
      const formatted = formatRateForShopify(
        rate,
        currency,
        config?.displayName,
      );
      return {
        name: formatted.service_name,
        code: formatted.service_code,
        price: parseInt(formatted.total_price, 10) / 100,
        currency,
        description: formatted.description,
      };
    });

    console.log(`[INGRAM] Parsed ${rates.length} shipping rates`);
    return rates;
  } catch (error) {
    console.error("[INGRAM] Cart estimate error:", error);
    return null;
  }
}

// Extract TECHDATA rate logic into a separate function
async function getTechDataRates(
  body: CartEstimateRequest,
  itemsWithVendor: Array<{
    item: CartEstimateRequest["items"][0];
    vendorInfo: {
      price_vendor_part: string;
      price_part_nbr: string;
      source_type: string;
    };
  }>,
) {
  try {
    if (itemsWithVendor.length === 0) return null;

    // Validate required fields
    if (!body.shop) {
      throw new Error("Missing shop domain");
    }

    if (!body.address || !body.address.country) {
      throw new Error("Missing address information");
    }

    // Check if credentials exist for this shop
    const td_credentials = await td_getCredentials(body.shop);
    if (!td_credentials) {
      throw new Error("Shop not configured for TECHDATA");
    }

    // Build ship-to address
    const shipToAddress = {
      companyName: "Customer",
      addressLine1: body.address.city || "Unknown",
      city: body.address.city || "Unknown",
      state: body.address.province || body.address.country,
      postalCode: body.address.zip || "00000",
      countryCode: body.address.country,
    };

    console.log(
      `[TECHDATA] Cart estimate: Requesting for ${itemsWithVendor.length} items to ${shipToAddress.postalCode}`,
    );

    // Request freight estimate from TECHDATA using vendor part numbers directly
    const response = await requestTd_FreightEstimate(body.shop, {
      addressName1: "Customer",
      addressLine1: body.address.city || "Unknown",
      city: body.address.city || "Unknown",
      state: body.address.province || body.address.country,
      zipCode: body.address.zip || "00000",
      country: body.address.country,
      shipFromWarehouse: "03", // Default warehouse
      Items: {
        Item: itemsWithVendor.map((data) => {
          return {
            itemSKU: data.vendorInfo.price_part_nbr, // Vendor SKU
            itemMfgPartNumber: data.vendorInfo.price_vendor_part, // Manufacturer part number
            itemQuantity: String(data.item.quantity),
          };
        }),
      },
    });

    console.log("[TECHDATA] Response:", response);

    // Parse XML response
    if (!response?.response) {
      console.warn("[TECHDATA] No response received");
      return null;
    }

    const xmlResponse = response.response as string;

    // Extract available shipping methods from XML
    const rates = parseTechDataShippingRates(xmlResponse);

    if (rates.length === 0) {
      console.warn("[TECHDATA] No shipping rates found in response");
      return null;
    }

    console.log(`[TECHDATA] Parsed ${rates.length} shipping rates from XML`);

    // Sync available carriers to database (for admin configuration)
    void syncTd_CarriersFromResponse(body.shop, rates).catch((syncError) => {
      console.error("[TECHDATA] Failed to sync carriers to DB:", syncError);
    });

    // Check if carrier configurations exist for filtering
    const td_hasConfigs = await hasTd_CarrierConfigurations(body.shop);

    let filteredRates = rates;

    if (td_hasConfigs) {
      const tdenabledCodes = await getEnabledTd_CarrierCodes(body.shop);
      console.log(
        `[TECHDATA] Filtering rates by ${tdenabledCodes.size} enabled carriers`,
      );

      filteredRates = rates.filter((rate) => tdenabledCodes.has(rate.code));

      console.log(
        `[TECHDATA] ${filteredRates.length} rates remaining after filtering`,
      );

      // If all rates were filtered out, return null
      if (filteredRates.length === 0) {
        console.warn(
          "[TECHDATA] All rates filtered out by carrier configuration",
        );
        return null;
      }
    }

    console.log(`[TECHDATA] Returning ${filteredRates.length} shipping rates`);
    return filteredRates;
  } catch (error) {
    console.error("[TECHDATA] Cart estimate error:", error);
    return null;
  }
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
