DO $configuration_owner$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.libraries'::regclass AND attname = 'configuration_owner_id' AND NOT attisdropped
  ) THEN
    ALTER TABLE "libraries" ADD COLUMN "configuration_owner_id" integer;
    ALTER TABLE "libraries" ADD CONSTRAINT "libraries_configuration_owner_id_users_id_fk"
      FOREIGN KEY ("configuration_owner_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

    UPDATE "libraries" AS library
    SET "configuration_owner_id" = owners.user_id
    FROM (
      SELECT library_id, min(user_id) AS user_id
      FROM "user_library_access"
      WHERE access_level = 'owner'
      GROUP BY library_id
      HAVING count(*) = 1
    ) AS owners
    WHERE library.id = owners.library_id AND library.configuration_owner_id IS NULL;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM pg_attribute owner_column
    JOIN pg_constraint fk ON fk.conrelid = owner_column.attrelid AND fk.conkey = ARRAY[owner_column.attnum]
    JOIN pg_attribute user_id ON user_id.attrelid = fk.confrelid AND fk.confkey = ARRAY[user_id.attnum]
    WHERE owner_column.attrelid = 'public.libraries'::regclass
      AND owner_column.attname = 'configuration_owner_id' AND NOT owner_column.attisdropped
      AND owner_column.atttypid = 'integer'::regtype AND NOT owner_column.attnotnull AND NOT owner_column.atthasdef
      AND fk.conname = 'libraries_configuration_owner_id_users_id_fk' AND fk.contype = 'f'
      AND fk.convalidated AND fk.confdeltype = 'n' AND fk.confupdtype = 'a'
      AND fk.confrelid = 'public.users'::regclass AND user_id.attname = 'id'
  ) THEN
    RAISE EXCEPTION 'Unexpected existing configuration-owner schema';
  END IF;
END
$configuration_owner$;
