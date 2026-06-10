// Migra Product.variations (Json legado) -> tabela ProductVariant
// e vincula Order.variantId quando possível.
// Não altera costPrice/calc*/profit de nenhum pedido (variant.costPrice começa null,
// fallback variant.costPrice ?? product.costPrice preserva os valores atuais).
const prisma = require('../src/lib/prisma');

function isRealVariation(variations) {
  if (!Array.isArray(variations) || variations.length === 0) return false;
  if (variations.length >= 2) return true;
  const v = variations[0];
  return v.modelId !== '0' || !!v.sku || !!v.name;
}

async function main() {
  const products = await prisma.product.findMany({
    where: { variations: { not: null } },
    select: { id: true, name: true, variations: true },
  });

  let createdVariants = 0;
  let touchedProducts = 0;

  for (const product of products) {
    const variations = product.variations;
    if (!isRealVariation(variations)) continue;

    touchedProducts++;
    for (const v of variations) {
      const modelId = v.modelId != null ? String(v.modelId) : '0';
      const result = await prisma.productVariant.upsert({
        where: { productId_marketplaceVariantId: { productId: product.id, marketplaceVariantId: modelId } },
        create: {
          productId: product.id,
          marketplaceVariantId: modelId,
          name: v.name || null,
          sku: v.sku || null,
          price: v.price ?? 0,
          stock: v.stock ?? 0,
        },
        update: {},
      });
      createdVariants++;
      console.log(`[variant] ${product.name} -> ${result.name || result.sku || result.marketplaceVariantId} (${result.id})`);
    }
  }

  console.log(`\n${touchedProducts} produto(s) com variações reais, ${createdVariants} ProductVariant upsertado(s).`);

  // Vincular Order.variantId via variationName/skuVariacao
  const orders = await prisma.order.findMany({
    where: { productId: { not: null }, variantId: null, OR: [{ variationName: { not: null } }, { skuVariacao: { not: null } }] },
    select: { id: true, productId: true, variationName: true, skuVariacao: true },
  });

  const variantsByProduct = new Map();
  let linked = 0;

  for (const order of orders) {
    if (!variantsByProduct.has(order.productId)) {
      const variants = await prisma.productVariant.findMany({ where: { productId: order.productId } });
      variantsByProduct.set(order.productId, variants);
    }
    const variants = variantsByProduct.get(order.productId);
    if (!variants.length) continue;

    const match = variants.find(v =>
      (order.variationName && v.name === order.variationName) ||
      (order.skuVariacao && v.sku === order.skuVariacao)
    );
    if (!match) continue;

    await prisma.order.update({ where: { id: order.id }, data: { variantId: match.id } });
    linked++;
  }

  console.log(`${linked} pedido(s) vinculado(s) a uma ProductVariant.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
