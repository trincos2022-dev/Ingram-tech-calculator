-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "IngramCredential" (
    "shopDomain" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "customerNumber" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL DEFAULT 'US',
    "contactEmail" TEXT,
    "senderId" TEXT,
    "billToAddressId" TEXT,
    "shipToAddressId" TEXT,
    "sandbox" BOOLEAN NOT NULL DEFAULT true,
    "accessToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidationStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngramCredential_pkey" PRIMARY KEY ("shopDomain")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Td_SynnexCredential" (
    "shopDomain" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "customerNumber" TEXT NOT NULL,
    "customerName" TEXT,
    "sandbox" BOOLEAN NOT NULL DEFAULT true,
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidationStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Td_SynnexCredential_pkey" PRIMARY KEY ("shopDomain")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CarrierConfiguration" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "carrierCode" TEXT NOT NULL,
    "carrierName" TEXT NOT NULL,
    "carrierMode" TEXT NOT NULL,
    "displayName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarrierConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Td_CarrierConfiguration" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "carrierCode" TEXT NOT NULL,
    "carrierName" TEXT NOT NULL,
    "displayName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Td_CarrierConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductMapping" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "ingramPartNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ProductSyncJob" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ProductSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CarrierFallbackRateSettings" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "carrierType" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 999.00,
    "title" TEXT NOT NULL DEFAULT 'Shipping Unavailable',
    "description" TEXT NOT NULL DEFAULT 'Please contact support before placing this order',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarrierFallbackRateSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CarrierRateRequestLog" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarrierRateRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CarrierConfiguration_shopDomain_idx" ON "CarrierConfiguration"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CarrierConfiguration_shopDomain_carrierCode_key" ON "CarrierConfiguration"("shopDomain", "carrierCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Td_CarrierConfiguration_shopDomain_idx" ON "Td_CarrierConfiguration"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Td_CarrierConfiguration_shopDomain_carrierCode_key" ON "Td_CarrierConfiguration"("shopDomain", "carrierCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductMapping_shopDomain_idx" ON "ProductMapping"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_shopDomain_sku_key" ON "ProductMapping"("shopDomain", "sku");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductSyncJob_shopDomain_idx" ON "ProductSyncJob"("shopDomain");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductSyncJob_status_idx" ON "ProductSyncJob"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductSyncJob_createdAt_idx" ON "ProductSyncJob"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CarrierFallbackRateSettings_shopDomain_idx" ON "CarrierFallbackRateSettings"("shopDomain");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CarrierFallbackRateSettings_carrierType_idx" ON "CarrierFallbackRateSettings"("carrierType");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CarrierFallbackRateSettings_shopDomain_carrierType_key" ON "CarrierFallbackRateSettings"("shopDomain", "carrierType");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CarrierRateRequestLog_correlationId_key" ON "CarrierRateRequestLog"("correlationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CarrierRateRequestLog_shopDomain_idx" ON "CarrierRateRequestLog"("shopDomain");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CarrierRateRequestLog_shopDomain_carrierType_idx" ON "CarrierRateRequestLog"("shopDomain", "carrierType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CarrierRateRequestLog_carrierType_idx" ON "CarrierRateRequestLog"("carrierType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CarrierRateRequestLog_createdAt_idx" ON "CarrierRateRequestLog"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CarrierRateRequestLog_status_idx" ON "CarrierRateRequestLog"("status");

