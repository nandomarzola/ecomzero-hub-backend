-- AlterTable
ALTER TABLE `Order` ADD COLUMN `snapshotCommission` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `snapshotFixedFee` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `snapshotServiceFee` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `snapshotTaxRate` DOUBLE NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `OrderItem` ADD COLUMN `snapshotCostPrice` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `snapshotPackaging` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `snapshotSupplies` DOUBLE NOT NULL DEFAULT 0;
