/**
 * Unified Carrier Rate Logging Service
 *
 * Centralized service for logging rate requests from all carriers (Ingram, TechData, etc.)
 * Provides carrier-specific query methods for viewing logs separately by carrier.
 */

import prisma from "../db.server";

// Carrier types supported by the system
export type CarrierType = "INGRAM" | "TECHDATA" | "UNIFIED";

// Unified rate log data structure
export type CarrierRateLogData = {
  shopDomain: string;
  correlationId: string;
  carrierType: CarrierType;
  requestType: "carrier_service" | "cart_estimate";
  cartItemCount: number;
  cartSkus: string[];
  vendorPartNums?: string[];
  shipToCity?: string;
  shipToState?: string;
  shipToZip?: string;
  shipToCountry?: string;
  status: "success" | "error" | "no_rates" | "no_mapping" | "api_error";
  carriersCount?: number;
  ratesReturned?: number;
  ratesData?: unknown;
  errorMessage?: string;
  errorDetails?: unknown;
  vendorRawResponse?: unknown;
  durationMs?: number;
};

// Truncate JSON for database storage to prevent oversized fields
function truncateJson(obj: unknown, maxLength: number = 10000): string {
  const json = JSON.stringify(obj);
  if (json.length <= maxLength) return json;
  return json.slice(0, maxLength) + "...[truncated]";
}

/**
 * Save carrier rate request log to unified database
 * Fire-and-forget: doesn't block the response
 */
export function saveCarrierRateLog(data: CarrierRateLogData): void {
  // Fire-and-forget: don't await, don't block the response
  prisma.carrierRateRequestLog
    .create({
      data: {
        shopDomain: data.shopDomain,
        correlationId: data.correlationId,
        carrierType: data.carrierType,
        requestType: data.requestType,
        cartItemCount: data.cartItemCount,
        cartSkus: JSON.stringify(data.cartSkus),
        vendorPartNums: data.vendorPartNums
          ? JSON.stringify(data.vendorPartNums)
          : null,
        shipToCity: data.shipToCity,
        shipToState: data.shipToState,
        shipToZip: data.shipToZip,
        shipToCountry: data.shipToCountry,
        status: data.status,
        carriersCount: data.carriersCount,
        ratesReturned: data.ratesReturned,
        ratesData: data.ratesData ? truncateJson(data.ratesData, 5000) : null,
        errorMessage: data.errorMessage,
        errorDetails: data.errorDetails
          ? truncateJson(data.errorDetails, 2000)
          : null,
        vendorRawResponse: data.vendorRawResponse
          ? truncateJson(data.vendorRawResponse, 8000)
          : null,
        durationMs: data.durationMs,
      },
    })
    .catch((err) => {
      console.error(
        `[${data.carrierType}] Failed to save carrier rate log:`,
        err,
      );
    });
}

// Query filters for rate logs
export type RateLogFilters = {
  status?: string;
  requestType?: "carrier_service" | "cart_estimate";
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
};

/**
 * Get Ingram rate logs for a specific shop
 */
export async function getIngramRateLogs(
  shopDomain: string,
  filters?: RateLogFilters,
) {
  return prisma.carrierRateRequestLog.findMany({
    where: {
      shopDomain,
      carrierType: "INGRAM",
      status: filters?.status,
      requestType: filters?.requestType,
      createdAt: {
        gte: filters?.startDate,
        lte: filters?.endDate,
      },
    },
    orderBy: { createdAt: "desc" },
    take: filters?.limit,
    skip: filters?.offset,
  });
}

/**
 * Get TechData rate logs for a specific shop
 */
export async function getTechDataRateLogs(
  shopDomain: string,
  filters?: RateLogFilters,
) {
  return prisma.carrierRateRequestLog.findMany({
    where: {
      shopDomain,
      carrierType: "TECHDATA",
      status: filters?.status,
      requestType: filters?.requestType,
      createdAt: {
        gte: filters?.startDate,
        lte: filters?.endDate,
      },
    },
    orderBy: { createdAt: "desc" },
    take: filters?.limit,
    skip: filters?.offset,
  });
}

/**
 * Get all carrier rate logs for a shop (across all carriers)
 */
export async function getAllCarrierRateLogs(
  shopDomain: string,
  filters?: RateLogFilters & { carrierType?: CarrierType },
) {
  return prisma.carrierRateRequestLog.findMany({
    where: {
      shopDomain,
      carrierType: filters?.carrierType,
      status: filters?.status,
      requestType: filters?.requestType,
      createdAt: {
        gte: filters?.startDate,
        lte: filters?.endDate,
      },
    },
    orderBy: { createdAt: "desc" },
    take: filters?.limit,
    skip: filters?.offset,
  });
}

/**
 * Get rate log by correlation ID
 */
export async function getRateLogByCorrelationId(correlationId: string) {
  return prisma.carrierRateRequestLog.findUnique({
    where: { correlationId },
  });
}

/**
 * Get rate log statistics for a shop
 */
export async function getRateLogStats(
  shopDomain: string,
  carrierType?: CarrierType,
  startDate?: Date,
  endDate?: Date,
) {
  const where = {
    shopDomain,
    carrierType,
    createdAt: {
      gte: startDate,
      lte: endDate,
    },
  };

  const [total, successful, errors, noRates, noMapping] = await Promise.all([
    prisma.carrierRateRequestLog.count({ where }),
    prisma.carrierRateRequestLog.count({
      where: { ...where, status: "success" },
    }),
    prisma.carrierRateRequestLog.count({
      where: { ...where, status: "error" },
    }),
    prisma.carrierRateRequestLog.count({
      where: { ...where, status: "no_rates" },
    }),
    prisma.carrierRateRequestLog.count({
      where: { ...where, status: "no_mapping" },
    }),
  ]);

  return {
    total,
    successful,
    errors,
    noRates,
    noMapping,
    successRate: total > 0 ? (successful / total) * 100 : 0,
  };
}

/**
 * Delete old rate logs (for cleanup jobs)
 */
export async function deleteOldRateLogs(
  olderThanDays: number,
  carrierType?: CarrierType,
) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  return prisma.carrierRateRequestLog.deleteMany({
    where: {
      carrierType,
      createdAt: {
        lt: cutoffDate,
      },
    },
  });
}
