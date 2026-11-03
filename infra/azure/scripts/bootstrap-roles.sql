-- One-time database setup after the first `terraform apply`. Run it as a member of the DBA Entra group.
-- Password sign-in is disabled on the server, so the "password" is an Entra access token:
--
--   export PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)
--   psql "host=<postgres_fqdn> dbname=postgres user=<your sign-in name> sslmode=require" \
--        -v migrate_role=<database_roles.migrate> -v app_role=<database_roles.app> -f bootstrap-roles.sql
--
-- The server is only reachable from inside the virtual network: run it from a jump host or Cloud Shell
-- attached to that network. Both role names are outputs of the Terraform configuration.

-- The two workload identities become database roles (no password, token sign-in only).
SELECT * FROM pgaadauth_create_principal(:'migrate_role', false, false);
SELECT * FROM pgaadauth_create_principal(:'app_role', false, false);

\connect hub

-- The migrate job owns the schema: it creates and alters tables.
GRANT USAGE, CREATE ON SCHEMA public TO :"migrate_role";

-- The api and worker read and write rows but cannot change the schema. Tables the migrate job creates
-- later are covered by the default privileges below.
GRANT USAGE ON SCHEMA public TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrate_role" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrate_role" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";

-- Run this part again after the first migration has created the tables: the audit trail is append-only
-- for the application, whatever bug or intruder gets hold of its identity.
-- REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM :"app_role";
