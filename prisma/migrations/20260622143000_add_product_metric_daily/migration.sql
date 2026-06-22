CREATE TABLE `ProductMetricDaily` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NULL,
    `marketplace` VARCHAR(191) NOT NULL,
    `externalId` VARCHAR(191) NULL,
    `metricDate` DATETIME(3) NOT NULL,
    `visits` INTEGER NOT NULL DEFAULT 0,
    `clicks` INTEGER NULL,
    `impressions` INTEGER NULL,
    `conversion` DOUBLE NULL,
    `adSpend` DOUBLE NULL,
    `adRevenue` DOUBLE NULL,
    `adOrders` INTEGER NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'api',
    `raw` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProductMetricDaily_storeId_metricDate_idx`(`storeId`, `metricDate`),
    INDEX `ProductMetricDaily_productId_metricDate_idx`(`productId`, `metricDate`),
    UNIQUE INDEX `ProductMetricDaily_storeId_externalId_metricDate_key`(`storeId`, `externalId`, `metricDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProductMetricDaily` ADD CONSTRAINT `ProductMetricDaily_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `Store`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ProductMetricDaily` ADD CONSTRAINT `ProductMetricDaily_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
