import prisma from "../db.server";

export type CarrierType = "INGRAM" | "TECHDATA" | "UNIFIED";

export type FallbackRateSettings = {
  shopDomain: string;
  carrierType?: CarrierType;
  enabled: boolean;
  price: number;
  title: string;
  description: string;
};

const DEFAULT_SETTINGS: Omit<
  FallbackRateSettings,
  "shopDomain" | "carrierType"
> = {
  enabled: true,
  price: 999.0,
  title: "Shipping Unavailable",
  description: "Please contact support before placing this order",
};

/**
 * Get carrier-specific fallback rate settings
 */
export async function getFallbackRateSettings(
  shopDomain: string,
  carrierType?: CarrierType,
): Promise<FallbackRateSettings> {
  try {
    if (!carrierType) {
      // CarrierType is required for unified table
      return {
        shopDomain,
        ...DEFAULT_SETTINGS,
      };
    }

    const settings = await prisma.carrierFallbackRateSettings.findUnique({
      where: {
        shopDomain_carrierType: {
          shopDomain,
          carrierType,
        },
      },
    });

    if (settings) {
      return {
        shopDomain: settings.shopDomain,
        carrierType: settings.carrierType as CarrierType,
        enabled: settings.enabled,
        price: settings.price,
        title: settings.title,
        description: settings.description,
      };
    }

    // Return defaults if no settings found
    return {
      shopDomain,
      carrierType,
      ...DEFAULT_SETTINGS,
    };
  } catch (err) {
    console.warn("CarrierFallbackRateSettings error:", err);
    return {
      shopDomain,
      carrierType,
      ...DEFAULT_SETTINGS,
    };
  }
}

/**
 * Save carrier-specific fallback rate settings
 */
export async function saveFallbackRateSettings(
  shopDomain: string,
  data: Partial<Omit<FallbackRateSettings, "shopDomain">>,
  carrierType?: CarrierType,
): Promise<FallbackRateSettings> {
  if (!carrierType) {
    throw new Error(
      "CarrierType is required for saving fallback rate settings",
    );
  }

  const settings = await prisma.carrierFallbackRateSettings.upsert({
    where: {
      shopDomain_carrierType: {
        shopDomain,
        carrierType,
      },
    },
    create: {
      shopDomain,
      carrierType,
      enabled: data.enabled ?? DEFAULT_SETTINGS.enabled,
      price: data.price ?? DEFAULT_SETTINGS.price,
      title: data.title ?? DEFAULT_SETTINGS.title,
      description: data.description ?? DEFAULT_SETTINGS.description,
    },
    update: {
      enabled: data.enabled,
      price: data.price,
      title: data.title,
      description: data.description,
      updatedAt: new Date(),
    },
  });

  return {
    shopDomain: settings.shopDomain,
    carrierType: settings.carrierType as CarrierType,
    enabled: settings.enabled,
    price: settings.price,
    title: settings.title,
    description: settings.description,
  };
}

/**
 * Get all fallback rate settings for a shop across all carriers
 */
export async function getAllCarrierFallbackRates(
  shopDomain: string,
): Promise<FallbackRateSettings[]> {
  const settings = await prisma.carrierFallbackRateSettings.findMany({
    where: { shopDomain },
  });

  return settings.map((s) => ({
    shopDomain: s.shopDomain,
    carrierType: s.carrierType as CarrierType,
    enabled: s.enabled,
    price: s.price,
    title: s.title,
    description: s.description,
  }));
}

/**
 * Format fallback rate for Shopify carrier service response
 */
export function formatFallbackRateForShopify(
  settings: FallbackRateSettings,
  currency: string = "USD",
): {
  service_name: string;
  service_code: string;
  total_price: string;
  description: string;
  currency: string;
} {
  // Shopify expects price in cents
  const priceInCents = Math.round(settings.price * 100);

  return {
    service_name: settings.title,
    service_code: "FALLBACK_RATE",
    total_price: String(priceInCents),
    description: settings.description,
    currency,
  };
}
