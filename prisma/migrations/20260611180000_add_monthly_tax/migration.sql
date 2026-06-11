-- CreateTable
CREATE TABLE `MonthlyTax` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `month` VARCHAR(191) NOT NULL,
    `revenueByStore` JSON NOT NULL,
    `totalRevenue` DOUBLE NOT NULL,
    `dasAmount` DOUBLE NULL,
    `effectiveRate` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MonthlyTax_userId_month_key`(`userId`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MonthlyTax` ADD CONSTRAINT `MonthlyTax_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
