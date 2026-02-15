-- Migration: Unified Carrier Rate Request Log
-- Creates a new unified table for all carrier rate logs (Ingram, TechData, etc.)
-- and migrates existing data from separate tables

-- Step 1: Create the unified CarrierRateRequestLog table
CREATE TABLE IF NOT EXISTS "CarrierRateRequestLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL UNIQUE,
    "carrierType" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "cartItemCount" INTEGER NOT NULL,
    "cartSkus" TEXT NOT NULL,
    "vendorPartNums" TEXT,
    "shipToCity" TEXT,
    "shipToState" TEXT,
    "shipToZip" TEXT,
    "shipToCountry" TEXT,
    "status" TEXT NOT NULL,
    "carriersCount" INTEGER,
    "ratesReturned" INTEGER,
    "ratesData" TEXT,
    "errorMessage" TEXT,
    "errorDetails" TEXT,
    "vendorRawResponse" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Step 2: Create indexes for performance
CREATE INDEX IF NOT EXISTS "CarrierRateRequestLog_shopDomain_idx" ON "CarrierRateRequestLog"("shopDomain");
CREATE INDEX IF NOT EXISTS "CarrierRateRequestLog_shopDomain_carrierType_idx" ON "CarrierRateRequestLog"("shopDomain", "carrierType");
CREATE INDEX IF NOT EXISTS "CarrierRateRequestLog_carrierType_idx" ON "CarrierRateRequestLog"("carrierType");
CREATE INDEX IF NOT EXISTS "CarrierRateRequestLog_createdAt_idx" ON "CarrierRateRequestLog"("createdAt");
CREATE INDEX IF NOT EXISTS "CarrierRateRequestLog_status_idx" ON "CarrierRateRequestLog"("status");

-- Step 3: Migrate data from RateRequestLog (Ingram) to CarrierRateRequestLog
INSERT INTO "CarrierRateRequestLog" (
    "id",
    "shopDomain",
    "correlationId",
    "carrierType",
    "requestType",
    "cartItemCount",
    "cartSkus",
    "vendorPartNums",
    "shipToCity",
    "shipToState",
    "shipToZip",
    "shipToCountry",
    "status",
    "carriersCount",
    "ratesReturned",
    "ratesData",
    "errorMessage",
    "errorDetails",
    "vendorRawResponse",
    "durationMs",
    "createdAt"
)
SELECT
    "id",
    "shopDomain",
    "correlationId",
    'INGRAM' as "carrierType",
    "requestType",
    "cartItemCount",
    "cartSkus",
    "ingramPartNums" as "vendorPartNums",
    "shipToCity",
    "shipToState",
    "shipToZip",
    "shipToCountry",
    "status",
    "distributionCount" as "carriersCount",
    "ratesReturned",
    "ratesData",
    "errorMessage",
    "errorDetails",
    "ingramRawResponse" as "vendorRawResponse",
    "durationMs",
    "createdAt"
FROM "RateRequestLog"
WHERE NOT EXISTS (
    SELECT 1 FROM "CarrierRateRequestLog"
    WHERE "CarrierRateRequestLog"."correlationId" = "RateRequestLog"."correlationId"
);

-- Step 4: Migrate data from TdRateRequestLog (TechData) to CarrierRateRequestLog
INSERT INTO "CarrierRateRequestLog" (
    "id",
    "shopDomain",
    "correlationId",
    "carrierType",
    "requestType",
    "cartItemCount",
    "cartSkus",
    "vendorPartNums",
    "shipToCity",
    "shipToState",
    "shipToZip",
    "shipToCountry",
    "status",
    "carriersCount",
    "ratesReturned",
    "ratesData",
    "errorMessage",
    "errorDetails",
    "vendorRawResponse",
    "durationMs",
    "createdAt"
)
SELECT
    "id",
    "shopDomain",
    "correlationId",
    'TECHDATA' as "carrierType",
    "requestType",
    "cartItemCount",
    "cartSkus",
    "tdPartNums" as "vendorPartNums",
    "shipToCity",
    "shipToState",
    "shipToZip",
    "shipToCountry",
    "status",
    "carriersCount",
    "ratesReturned",
    "ratesData",
    "errorMessage",
    "errorDetails",
    "tdRawResponse" as "vendorRawResponse",
    "durationMs",
    "createdAt"
FROM "TdRateRequestLog"
WHERE NOT EXISTS (
    SELECT 1 FROM "CarrierRateRequestLog"
    WHERE "CarrierRateRequestLog"."correlationId" = "TdRateRequestLog"."correlationId"
);

-- Step 5: Verification queries (run these manually to verify migration)
-- SELECT COUNT(*) as ingram_original FROM "RateRequestLog";
-- SELECT COUNT(*) as techdata_original FROM "TdRateRequestLog";
-- SELECT COUNT(*) as ingram_migrated FROM "CarrierRateRequestLog" WHERE "carrierType" = 'INGRAM';
-- SELECT COUNT(*) as techdata_migrated FROM "CarrierRateRequestLog" WHERE "carrierType" = 'TECHDATA';
-- SELECT COUNT(*) as total_unified FROM "CarrierRateRequestLog";

-- Step 6: Drop old tables (data has been migrated to CarrierRateRequestLog)
DROP TABLE IF EXISTS "RateRequestLog";
DROP TABLE IF EXISTS "TdRateRequestLog";
