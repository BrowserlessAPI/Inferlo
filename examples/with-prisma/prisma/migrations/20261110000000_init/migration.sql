-- CreateTable
CREATE TABLE "crm_customers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "crm_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_invoices" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "cents" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_invoices_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "crm_invoices" ADD CONSTRAINT "crm_invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "crm_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
