-- Migration: Unified Carrier Fallback Rate Settings
-- Creates a new unified table for all carrier fallback rates (Ingram, TechData, etc.)
-- and migrates existing data from separate tables

-- Step 1: Create the unified CarrierFallbackRateSettings table
CREATE TABLE IF NOT EXISTS "CarrierFallbackRateSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "carrierType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 999.00,
    "title" TEXT NOT NULL DEFAULT 'Shipping Unavailable',
    "description" TEXT NOT NULL DEFAULT 'Please contact support before placing this order',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Step 2: Create indexes for performance
CREATE UNIQUE INDEX IF NOT EXISTS "CarrierFallbackRateSettings_shopDomain_carrierType_key"
    ON "CarrierFallbackRateSettings"("shopDomain", "carrierType");
CREATE INDEX IF NOT EXISTS "CarrierFallbackRateSettings_shopDomain_idx"
    ON "CarrierFallbackRateSettings"("shopDomain");
CREATE INDEX IF NOT EXISTS "CarrierFallbackRateSettings_carrierType_idx"
    ON "CarrierFallbackRateSettings"("carrierType");

-- Step 3: Migrate data from FallbackRateSettings (Ingram) to CarrierFallbackRateSettings
INSERT INTO "CarrierFallbackRateSettings" (
    "id",
    "shopDomain",
    "carrierType",
    "enabled",
    "price",
    "title",
    "description",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text as "id",
    "shopDomain",
    'INGRAM' as "carrierType",
    "enabled",
    "price",
    "title",
    "description",
    "createdAt",
    "updatedAt"
FROM "FallbackRateSettings"
WHERE NOT EXISTS (
    SELECT 1 FROM "CarrierFallbackRateSettings"
    WHERE "CarrierFallbackRateSettings"."shopDomain" = "FallbackRateSettings"."shopDomain"
    AND "CarrierFallbackRateSettings"."carrierType" = 'INGRAM'
);

-- Step 4: Migrate data from TdFallbackRateSettings (TechData) to CarrierFallbackRateSettings
INSERT INTO "CarrierFallbackRateSettings" (
    "id",
    "shopDomain",
    "carrierType",
    "enabled",
    "price",
    "title",
    "description",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text as "id",
    "shopDomain",
    'TECHDATA' as "carrierType",
    "enabled",
    "price",
    "title",
    "description",
    "createdAt",
    "updatedAt"
FROM "TdFallbackRateSettings"
WHERE NOT EXISTS (
    SELECT 1 FROM "CarrierFallbackRateSettings"
    WHERE "CarrierFallbackRateSettings"."shopDomain" = "TdFallbackRateSettings"."shopDomain"
    AND "CarrierFallbackRateSettings"."carrierType" = 'TECHDATA'
);

-- Step 5: Verification queries (run these manually to verify migration)
-- SELECT COUNT(*) as ingram_original FROM "FallbackRateSettings";
-- SELECT COUNT(*) as techdata_original FROM "TdFallbackRateSettings";
-- SELECT COUNT(*) as ingram_migrated FROM "CarrierFallbackRateSettings" WHERE "carrierType" = 'INGRAM';
-- SELECT COUNT(*) as techdata_migrated FROM "CarrierFallbackRateSettings" WHERE "carrierType" = 'TECHDATA';
-- SELECT COUNT(*) as total_unified FROM "CarrierFallbackRateSettings";

-- Step 6: Drop old tables (data has been migrated to CarrierFallbackRateSettings)
DROP TABLE IF EXISTS "FallbackRateSettings";
DROP TABLE IF EXISTS "TdFallbackRateSettings";
