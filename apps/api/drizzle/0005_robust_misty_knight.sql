ALTER TABLE "categories" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
UPDATE "categories"
SET "is_active" = false, "updated_at" = now()
WHERE "name" NOT IN (
  'Animal feeds',
  'Mineral blocks and supplements',
  'Consumables',
  'Veterinary medicines',
  'Fertilizers and Agrochemicals'
);
--> statement-breakpoint
WITH wanted(name, sort_order) AS (
  VALUES
    ('Animal feeds', 1),
    ('Mineral blocks and supplements', 2),
    ('Consumables', 3),
    ('Veterinary medicines', 4),
    ('Fertilizers and Agrochemicals', 5)
)
UPDATE "categories" AS category
SET "is_active" = true, "sort_order" = wanted.sort_order, "updated_at" = now()
FROM wanted
WHERE category."name" = wanted.name;
--> statement-breakpoint
WITH wanted(name, sort_order) AS (
  VALUES
    ('Animal feeds', 1),
    ('Mineral blocks and supplements', 2),
    ('Consumables', 3),
    ('Veterinary medicines', 4),
    ('Fertilizers and Agrochemicals', 5)
)
INSERT INTO "categories" ("name", "sort_order", "is_active")
SELECT wanted.name, wanted.sort_order, true
FROM wanted
WHERE NOT EXISTS (
  SELECT 1 FROM "categories" AS category WHERE category."name" = wanted.name
);
