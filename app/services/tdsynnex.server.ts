import z from "zod";
import prisma from "../db.server";
import { createTtlCache } from "app/utils/ttl-cache.server";
import { Td_SynnexCredential } from "@prisma/client";

const FREIGHT_URL = "https://ec.us.tdsynnex.com/SynnexXML/FreightQuote";
const SANDBOX_FREIGHT_URL =
  "https://ec.us.tdsynnex.com/sandbox/SynnexXML/FreightQuote";

const TOKEN_EXPIRY_BUFFER_SECONDS = 60;
const FREIGHT_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const FREIGHT_CACHE_MAX_ENTRIES = 200;
const freightEstimateCache = createTtlCache<
  string,
  {
    ingramCorrelationId: string;
    response: unknown;
  }
>({
  ttlMs: FREIGHT_CACHE_TTL_MS,
  maxEntries: FREIGHT_CACHE_MAX_ENTRIES,
});
// const inflightFreightRequests = new Map<
//   string,
//   Promise<{
//     correlationId: string;
//     response: unknown;
//     cacheHit: boolean;
//   }>
// >();

export const tdSynnex_credentialSchema = z.object({
  userName: z.string().min(1),
  password: z.string().min(1),
  customerNumber: z.string().min(1),
  customerName: z.string().optional(),
  sandbox: z.union([z.string(), z.boolean()]).optional(),
});

export type Td_CredentialInput = z.infer<typeof tdSynnex_credentialSchema>;

const tdSynnex_itemSchema = z.object({
  itemSKU: z.string().min(1),
  itemMfgPartNumber: z.string().min(1),
  itemQuantity: z.string().min(1),
});

const tdSynnex_rateTestSchema = z.object({
  addressName1: z.string().min(1),
  addressName2: z.string().optional().nullable(),
  addressLine1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(2),
  zipCode: z.string().min(3),
  country: z.string().min(2).max(2),
  shipFromWarehouse: z.string().min(1),
  serviceLevel: z.string().optional().nullable(),
  shipMethodCode: z.string().optional().nullable(),
  Items: z.object({
    Item: z.union([z.array(tdSynnex_itemSchema), tdSynnex_itemSchema]),
  }),
});

export type Td_RateTestInput = z.infer<typeof tdSynnex_rateTestSchema>;

export class Td_synnexError extends Error {
  public readonly status?: number;
  public readonly details?: unknown;

  constructor(message: string, opts?: { status?: number; details?: unknown }) {
    super(message);
    this.name = "Td_synnexError";
    this.status = opts?.status;
    this.details = opts?.details;
  }
}

export async function td_getCredentials(shopDomain: string) {
  return prisma.td_SynnexCredential.findUnique({
    where: { shopDomain },
  });
}

export async function td_saveCredentials(
  shopDomain: string,
  data: Td_CredentialInput,
) {
  const sandboxFlag =
    typeof data.sandbox === "boolean"
      ? data.sandbox
      : data.sandbox
        ? String(data.sandbox).toLowerCase() === "true" ||
          String(data.sandbox).toLowerCase() === "on" ||
          String(data.sandbox) === "1"
        : true;
  const record = await prisma.td_SynnexCredential.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      userName: data.userName,
      password: data.password,
      customerNumber: data.customerNumber,
      customerName: data.customerName || "",
      sandbox: sandboxFlag,
      lastValidationStatus: "Never run",
    },
    update: {
      userName: data.userName,
      password: data.password,
      customerNumber: data.customerNumber,
      customerName: data.customerName,
      sandbox: sandboxFlag,
    },
  });

  return record;
}

async function getTd_CredentialsOrThrow(shopDomain: string) {
  const td_credentials = await td_getCredentials(shopDomain);

  if (!td_credentials) {
    throw new Td_synnexError(
      "No Ingram Micro credentials configured for shop.",
    );
  }

  return td_credentials;
}

export function parseTd_CredentialFormData(formData: FormData) {
  return tdSynnex_credentialSchema.safeParse({
    userName: formData.get("userName"),
    password: formData.get("password"),
    customerNumber: formData.get("customerNumber"),
    customerName: formData.get("customerName") ?? "",
    sandbox: formData.get("sandbox") ?? "true",
  });
}

//td_synnex parseRateTest
export function td_parseRateTestFormData(formData: FormData) {
  // Helper to get string value or empty string for required fields
  const getStringValue = (key: string): string => {
    const value = formData.get(key);
    return value ? String(value) : "";
  };

  // Helper to get optional string value (null/undefined if empty)
  const getOptionalStringValue = (key: string): string | null => {
    const value = formData.get(key);
    return value ? String(value) : null;
  };

  const dataToValidate = {
    addressName1: getStringValue("addressName1"),
    addressName2: getOptionalStringValue("addressName2"),
    addressLine1: getStringValue("addressLine1"),
    city: getStringValue("city"),
    state: getStringValue("state"),
    zipCode: getStringValue("zipCode"),
    country: getStringValue("country").toUpperCase(),
    shipFromWarehouse: getStringValue("shipFromWarehouse"),
    serviceLevel: getOptionalStringValue("serviceLevel"),
    shipMethodCode: getOptionalStringValue("shipMethodCode"),
    Items: {
      Item: {
        itemSKU: getStringValue("itemSKU"),
        itemMfgPartNumber: getStringValue("itemMfgPartNumber"),
        itemQuantity: getStringValue("itemQuantity"),
      },
    },
  };

  console.log(
    "[TD SYNNEX] Form data received:",
    JSON.stringify(dataToValidate, null, 2),
  );

  const parsed = tdSynnex_rateTestSchema.safeParse(dataToValidate);

  if (!parsed.success) {
    const flattened = parsed.error.flatten();
    const formErrors = flattened.formErrors.join(", ");
    const fieldErrors = Object.entries(flattened.fieldErrors)
      .map(([field, errors]) => `${field}: ${errors?.join(", ")}`)
      .join("; ");
    const errorMessage = [formErrors, fieldErrors].filter(Boolean).join("; ");

    console.error("[TD SYNNEX] Validation failed:", errorMessage);
    console.error("[TD SYNNEX] Raw error:", parsed.error);

    return {
      success: false as const,
      error: errorMessage || "Validation failed",
    };
  }

  return {
    success: true as const,
    data: parsed.data,
  };
}

//td_synnex freightEstimate api
export async function requestTd_FreightEstimate(
  shopDomain: string,
  payload: Td_RateTestInput,
  opts?: {
    credentials?: Td_SynnexCredential;
  },
) {
  try {
    const credentials =
      opts?.credentials ?? (await getTd_CredentialsOrThrow(shopDomain));

    if (!credentials.password) {
      throw new Td_synnexError(
        "Missing contact email. Update the credentials form before testing rates.",
      );
    }

    const xmlBody = buildTdFreightXml(credentials, payload);
    console.log(xmlBody);

    const response = await fetch(
      credentials.sandbox ? SANDBOX_FREIGHT_URL : FREIGHT_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/xml",
          Accept: "text/xml",
        },
        body: xmlBody,
      },
    );
    console.log(response);
    const responseText = await response.text();

    if (!response.ok) {
      console.error(
        `[TD SYNNEX] Freight estimate failed: ${response.status} ${response.statusText}`,
        responseText,
      );

      throw new Td_synnexError("Failed to fetch freight estimate", {
        status: response.status,
        details: responseText,
      });
    }

    return {
      response: responseText, // parse XML upstream if needed
      cacheHit: false,
    };
  } catch (e) {
    // Preserve original error if already a Td_synnexError
    if (e instanceof Td_synnexError) {
      throw e;
    }

    // Re-throw any other errors (network errors, etc.)
    console.error(
      "[TD SYNNEX] Unexpected error in requestTd_FreightEstimate:",
      e,
    );
    throw new Td_synnexError(
      `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      { details: e },
    );
  }
}

function normalizeItems(items: Td_RateTestInput["Items"]["Item"]) {
  return Array.isArray(items) ? items : [items];
}

function buildTdFreightXml(
  credentials: Td_SynnexCredential,
  input: Td_RateTestInput,
) {
  const items = normalizeItems(input.Items.Item);

  return `<?xml version="1.0" encoding="UTF-8"?>
<SynnexB2B>
  <Credential>
    <UserID>${credentials.userName}</UserID>
    <Password>${credentials.password}</Password>
  </Credential>
  <FreightQuoteRequest version="2.0">
    <CustomerNumber>${credentials.customerNumber}</CustomerNumber>
    <RequestDateTime>${new Date().toISOString()}</RequestDateTime>
    <ShipFromWarehouse>${input.shipFromWarehouse ?? ""}</ShipFromWarehouse>
    <ShipTo>
      <AddressName1>${input.addressName1}</AddressName1>
      ${
        input.addressName2
          ? `<AddressName2>${input.addressName2}</AddressName2>`
          : ""
      }
      <AddressLine1>${input.addressLine1}</AddressLine1>
      <City>${input.city}</City>
      <State>${input.state}</State>
      <ZipCode>${input.zipCode}</ZipCode>
      <Country>${input.country}</Country>
    </ShipTo>
    ${input.serviceLevel ? `<ServiceLevel>${input.serviceLevel}</ServiceLevel>` : ""}
    <ShipMethodCode>${input.shipMethodCode ?? ""}</ShipMethodCode>
    <Items>
      ${items
        .map(
          (item, idx) => `
      <Item lineNumber="${item.lineNumber ?? idx + 1}">
        <SKU>${item.itemSKU}</SKU>
        <MfgPartNumber>${item.itemMfgPartNumber}</MfgPartNumber>
        <Quantity>${item.itemQuantity}</Quantity>
      </Item>`,
        )
        .join("")}
    </Items>
  </FreightQuoteRequest>
</SynnexB2B>`;
}

// ============================================================================
// Td_Carrier Configuration Functions
// ============================================================================

export type td_CarrierConfig = {
  carrierCode: string;
  carrierName: string;
  displayName: string | null;
  enabled: boolean;
  sortOrder: number;
};

/**
 * Get all carrier configurations for a shop
 */
export async function getTd_CarrierConfigurations(
  shopDomain: string,
): Promise<td_CarrierConfig[]> {
  const configs = await prisma.td_CarrierConfiguration.findMany({
    where: { shopDomain },
    orderBy: [{ sortOrder: "asc" }, { carrierName: "asc" }],
  });

  return configs.map((c) => ({
    carrierCode: c.carrierCode,
    carrierName: c.carrierName,
    displayName: c.displayName,
    enabled: c.enabled,
    sortOrder: c.sortOrder,
  }));
}

/**
 * Get only enabled carrier codes for a shop
 */
export async function getEnabledTd_CarrierCodes(
  shopDomain: string,
): Promise<Set<string>> {
  const configs = await prisma.td_CarrierConfiguration.findMany({
    where: { shopDomain, enabled: true },
    select: { carrierCode: true },
  });

  return new Set(configs.map((c) => c.carrierCode));
}

/**
 * Check if any carrier configurations exist for shop
 */
export async function hasTd_CarrierConfigurations(
  shopDomain: string,
): Promise<boolean> {
  const count = await prisma.td_CarrierConfiguration.count({
    where: { shopDomain },
  });
  return count > 0;
}

/**
 * Upsert a single carrier configuration
 */
export async function upsertTd_CarrierConfiguration(
  shopDomain: string,
  config: {
    carrierCode: string;
    carrierName: string;
    displayName?: string | null;
    enabled?: boolean;
    sortOrder?: number;
  },
) {
  return prisma.td_CarrierConfiguration.upsert({
    where: {
      shopDomain_carrierCode: {
        shopDomain,
        carrierCode: config.carrierCode,
      },
    },
    create: {
      shopDomain,
      carrierCode: config.carrierCode,
      carrierName: config.carrierName,
      displayName: config.displayName ?? null,
      enabled: config.enabled ?? true,
      sortOrder: config.sortOrder ?? 0,
    },
    update: {
      carrierName: config.carrierName,
      displayName: config.displayName ?? null,
      enabled: config.enabled ?? true,
      sortOrder: config.sortOrder ?? 0,
    },
  });
}

/**
 * Sync carriers from TDSynex API response to database
 * This populates the carrier configuration table with available options
 */
export async function syncTd_CarriersFromResponse(
  shopDomain: string,
  carriers: Array<{
    name?: string;
    code?: string;
    description?: string;
  }>,
) {
  console.log(
    `[syncCarriers] Starting sync for ${shopDomain} with ${carriers.length} carriers`,
  );

  const seenCarriers = new Map<string, { carrierName: string }>();

  // Collect unique carriers from response
  for (const carrier of carriers) {
    const code = carrier.code?.trim();
    if (!code) {
      console.warn(`[syncCarriers] Skipping carrier with empty code:`, carrier);
      continue;
    }

    if (!seenCarriers.has(code)) {
      seenCarriers.set(code, {
        carrierName:
          carrier.name?.trim() || carrier.description?.trim() || code,
      });
      console.log(
        `[syncCarriers] Found new carrier: ${code} (${carrier.name || "no name"})`,
      );
    }
  }

  console.log(
    `[syncCarriers] Found ${seenCarriers.size} unique carriers to sync`,
  );

  // Upsert each carrier (preserving existing enabled state)
  const existingConfigs = await getTd_CarrierConfigurations(shopDomain);
  const existingMap = new Map(existingConfigs.map((c) => [c.carrierCode, c]));
  console.log(
    `[syncCarriers] Existing carrier configs in DB: ${existingConfigs.length}`,
  );

  let sortOrder = 0;
  let newCount = 0;
  let updatedCount = 0;

  for (const [carrierCode, data] of seenCarriers) {
    const existing = existingMap.get(carrierCode);

    try {
      await upsertTd_CarrierConfiguration(shopDomain, {
        carrierCode,
        carrierName: data.carrierName,
        enabled: existing?.enabled ?? true, // Default to enabled for new carriers
        sortOrder: existing?.sortOrder ?? sortOrder++,
      });

      if (existing) {
        updatedCount++;
        console.log(`[syncCarriers] Updated carrier: ${carrierCode}`);
      } else {
        newCount++;
        console.log(
          `[syncCarriers] Created new carrier: ${carrierCode} - ${data.carrierName}`,
        );
      }
    } catch (error) {
      console.error(
        `[syncCarriers] Failed to upsert carrier ${carrierCode}:`,
        error,
      );
      throw error; // Re-throw to catch in the calling code
    }
  }

  console.log(
    `[syncCarriers] Sync complete: ${newCount} new, ${updatedCount} updated, ${seenCarriers.size} total`,
  );
  return seenCarriers.size;
}

export async function updateTd_CarrierEnabledStatus(
  shopDomain: string,
  updates: Array<{ carrierCode: string; enabled: boolean }>,
) {
  const results = await Promise.all(
    updates.map(({ carrierCode, enabled }) =>
      prisma.td_CarrierConfiguration.updateMany({
        where: { shopDomain, carrierCode },
        data: { enabled },
      }),
    ),
  );

  return results.reduce((sum, r) => sum + r.count, 0);
}
