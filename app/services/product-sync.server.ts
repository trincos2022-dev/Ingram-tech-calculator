import prisma from "../db.server";
import { getSupabaseClient } from "./supabase.server";

export type ProductSyncJobStatus = "queued" | "running" | "success" | "failed";

const STALE_JOB_THRESHOLD_MS = 30 * 60 * 1000;

export async function getLatestProductSyncJob(shopDomain: string) {
  try {
    await markStaleJobsAsFailed(shopDomain);

    return await prisma.productSyncJob.findFirst({
      where: { shopDomain },
      orderBy: { createdAt: "desc" },
    });
  } catch (err) {
    console.warn("ProductSyncJob table not available:", err);
    return null;
  }
}

async function markStaleJobsAsFailed(shopDomain: string) {
  const staleThreshold = new Date(Date.now() - STALE_JOB_THRESHOLD_MS);

  await prisma.productSyncJob.updateMany({
    where: {
      shopDomain,
      status: "running",
      createdAt: { lt: staleThreshold },
    },
    data: {
      status: "failed",
      error: "Sync timed out - job was running too long",
      finishedAt: new Date(),
    },
  });
}

export async function startProductSync(shopDomain: string) {
  try {
    await markStaleJobsAsFailed(shopDomain);

    const existing = await prisma.productSyncJob.findFirst({
      where: {
        shopDomain,
        status: "running",
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      return existing;
    }

    const job = await prisma.productSyncJob.create({
      data: {
        shopDomain,
        status: "running",
        processed: 0,
        total: 0,
      },
    });

    await runProductSyncFast(job.id, shopDomain);

    return await prisma.productSyncJob.findUnique({
      where: { id: job.id },
    });
  } catch (err) {
    console.error("Failed to start product sync:", err);
    throw new Error(err instanceof Error ? err.message : "Product sync failed");
  }
}

async function runProductSyncFast(jobId: string, shopDomain: string) {
  try {
    console.log(`[Product Sync] Starting fast sync for ${shopDomain}`);

    const supabase = getSupabaseClient();
    const PAGE_SIZE = 10000;
    const allRows: {
      id: number;
      price_vendor_part: string;
      price_part_nbr: string;
    }[] = [];
    let offset = 0;
    let totalCount = 0;
    let totalDroppedByFilter = 0;

    // Paginate through all rows
    while (true) {
      const { data, error, count } = await supabase
        .from("final_product_table_us")
        .select("id,price_vendor_part,price_part_nbr", { count: "exact" })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        throw new Error(`Supabase error: ${error.message}`);
      }

      if (count && count > 0) {
        totalCount = count;
      }

      const rawRows = data ?? [];

      const validRows = rawRows.filter(
        (
          row,
        ): row is {
          id: number;
          price_vendor_part: string;
          price_part_nbr: string;
        } =>
          // FIX: use != null checks instead of Boolean() so id=0 and
          // non-empty strings are not falsely dropped.
          row.id != null &&
          row.price_vendor_part != null &&
          row.price_vendor_part.trim() !== "" &&
          row.price_part_nbr != null &&
          row.price_part_nbr.trim() !== "",
      );

      // Diagnostic: log any rows dropped by the filter on this page
      const droppedOnPage = rawRows.length - validRows.length;
      if (droppedOnPage > 0) {
        totalDroppedByFilter += droppedOnPage;
        console.warn(
          `[Product Sync] ⚠️ Dropped ${droppedOnPage} rows with null/empty fields at offset ${offset}`,
        );
      }

      if (validRows.length === 0 && rawRows.length === 0) {
        // No more data from Supabase at all
        break;
      }

      allRows.push(...validRows);
      console.log(
        `[Product Sync] Fetched ${allRows.length}/${totalCount} rows from Supabase (page offset ${offset})`,
      );

      // FIX: Break based on RAW data length, not validRows length.
      // Previously, if even 1 row was filtered out, the loop would stop early
      // even though Supabase had more pages to return.
      if (rawRows.length < PAGE_SIZE) {
        break;
      }

      offset += PAGE_SIZE;
    }

    const rows = allRows;
    console.log(
      `[Product Sync] Total fetched: ${rows.length} rows from Supabase (Supabase reported ${totalCount} total)`,
    );

    if (totalDroppedByFilter > 0) {
      console.warn(
        `[Product Sync] ⚠️ Total rows dropped by null/empty filter: ${totalDroppedByFilter}`,
      );
    }

    if (totalCount > 0 && rows.length < totalCount) {
      console.warn(
        `[Product Sync] ⚠️ Fetched ${rows.length} rows but Supabase has ${totalCount} — ${totalCount - rows.length} rows missing!`,
      );
    }

    // Dedupe by SKU (keep last occurrence)
    const uniqueMappings = new Map<string, string>();
    for (const row of rows) {
      uniqueMappings.set(row.price_vendor_part, row.price_part_nbr);
    }

    const total = uniqueMappings.size;

    // Diagnostic: log deduplication loss
    const dedupRemoved = rows.length - total;
    if (dedupRemoved > 0) {
      console.warn(
        `[Product Sync] ⚠️ Deduplication removed ${dedupRemoved} duplicate SKUs (${rows.length} → ${total} unique)`,
      );
    } else {
      console.log(`[Product Sync] No duplicates found. ${total} unique SKUs.`);
    }

    // Update job with total count
    await prisma.productSyncJob.update({
      where: { id: jobId },
      data: { total },
    });

    // Delete existing mappings for this shop
    const deletedCount = await prisma.productMapping.deleteMany({
      where: { shopDomain },
    });
    console.log(
      `[Product Sync] Deleted ${deletedCount.count} existing mappings for ${shopDomain}`,
    );

    // Bulk insert in batches
    const BATCH_SIZE = 100000;
    const mappingsArray = Array.from(uniqueMappings.entries());
    let processed = 0;

    for (let i = 0; i < mappingsArray.length; i += BATCH_SIZE) {
      const batch = mappingsArray
        .slice(i, i + BATCH_SIZE)
        .map(([sku, ingramPartNumber]) => ({
          shopDomain,
          sku,
          ingramPartNumber,
        }));

      const result = await prisma.productMapping.createMany({
        data: batch,
        skipDuplicates: true,
      });

      // Diagnostic: detect if skipDuplicates silently dropped rows
      if (result.count < batch.length) {
        console.warn(
          `[Product Sync] ⚠️ Batch at offset ${i}: inserted ${result.count} but expected ${batch.length} — ${batch.length - result.count} skipped as duplicates`,
        );
      }

      processed += result.count;

      await prisma.productSyncJob.update({
        where: { id: jobId },
        data: { processed },
      });
    }

    // Final count verification
    const finalDbCount = await prisma.productMapping.count({
      where: { shopDomain },
    });
    console.log(
      `[Product Sync] ✅ Final DB count: ${finalDbCount} mappings (synced ${processed} / expected ${total})`,
    );

    if (finalDbCount !== total) {
      console.warn(
        `[Product Sync] ⚠️ Mismatch: DB has ${finalDbCount} but we expected ${total}`,
      );
    }

    // Mark as success
    await prisma.productSyncJob.update({
      where: { id: jobId },
      data: {
        status: "success",
        processed,
        total,
        finishedAt: new Date(),
      },
    });

    console.log(
      `[Product Sync] Completed: ${processed} mappings synced for ${shopDomain}`,
    );
  } catch (error) {
    console.error("[Product Sync] Failed:", error);
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown error";

    await prisma.productSyncJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: message,
        finishedAt: new Date(),
      },
    });

    throw error;
  }
}