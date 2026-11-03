variable "workload" {
  description = "Short name used in every resource name."
  type        = string
  default     = "dhub"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,7}$", var.workload))
    error_message = "workload must be 3 to 8 lowercase letters or digits, starting with a letter (it is part of globally unique names)."
  }
}

variable "environment" {
  description = "Environment name; one root per environment."
  type        = string

  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment must be dev, test or prod."
  }
}

variable "location" {
  description = "Azure region. It must have availability zones (zone-redundant database and container environment)."
  type        = string
  default     = "uksouth"

  validation {
    condition     = contains(["uksouth", "northeurope", "westeurope", "swedencentral", "francecentral", "germanywestcentral"], var.location)
    error_message = "Pick a region with availability zones for PostgreSQL zone-redundant HA and zone-redundant Container Apps: uksouth, northeurope, westeurope, swedencentral, francecentral or germanywestcentral."
  }
}

variable "address_space" {
  description = "VNet CIDR. Must not overlap anything it will be peered or connected with."
  type        = string
  default     = "10.40.0.0/22"

  validation {
    condition     = can(cidrhost(var.address_space, 0)) && tonumber(split("/", var.address_space)[1]) == 22
    error_message = "address_space must be a /22: half of it is the Container Apps subnet (/23), a /28 inside the other half is the database subnet."
  }
}

variable "tags" {
  description = "Extra tags. owner and cost_centre are required by the governance policy."
  type        = map(string)

  validation {
    condition     = alltrue([for k in ["owner", "cost_centre"] : contains(keys(var.tags), k)])
    error_message = "tags must contain owner and cost_centre."
  }
}

# ------------------------------------------------------------------ identity

variable "extra_redirect_uris" {
  description = "Additional places the browser app may return to after sign-in (a custom domain). The Container App's own address is added automatically. https only."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for u in var.extra_redirect_uris : can(regex("^https://", u))])
    error_message = "Each extra redirect URI must start with https://."
  }
}

variable "role_groups" {
  description = "Entra group object id per application role: { author = \"<guid>\", company_secretary = \"<guid>\", legal = ..., cfo = ..., publisher = ... }. Members get the role in their token. Empty means assign roles by hand in the portal."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for r in keys(var.role_groups) : contains(["author", "company_secretary", "legal", "cfo", "publisher"], r)])
    error_message = "role_groups keys must be author, company_secretary, legal, cfo or publisher."
  }
}

variable "default_company_id" {
  description = "The company every signed-in user acts for (OIDC_DEFAULT_ISSUER). Must exist in issuers_json."
  type        = string
}

variable "issuers_json" {
  description = "Companies served by this deployment, as JSON: [{\"id\":\"acme\",\"name\":\"Acme plc\",\"profiles\":{\"UK\":{\"tidm\":\"ACME\",\"lei\":\"...\"}}}]. Stored in the database and visible in the container configuration: identifiers only (TIDM, LEI, CIK), never filing credentials such as an EDGAR CCC. Those belong in Key Vault, wired in with the real gateway adapters."
  type        = string

  validation {
    condition     = can(jsondecode(var.issuers_json)) && length(jsondecode(var.issuers_json)) > 0
    error_message = "issuers_json must be a non-empty JSON array."
  }
}

variable "dba_group_object_id" {
  description = "Object id of the Entra group that administers PostgreSQL. Password sign-in is disabled, so without it nobody can create the database roles."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", var.dba_group_object_id))
    error_message = "dba_group_object_id must be a GUID."
  }
}

variable "github_repository" {
  description = "owner/name of the repository whose workflow may deploy (federated credential, no secret). null disables the CI identity."
  type        = string
  default     = null

  validation {
    condition     = var.github_repository == null || can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", coalesce(var.github_repository, "x/x")))
    error_message = "github_repository must look like owner/name."
  }
}

# ------------------------------------------------------------------ sizing (see docs/SIZING.md)

variable "api_replicas" {
  description = "Minimum and maximum API replicas. The minimum is 2 so a zone failure or a deploy never leaves zero."
  type        = object({ min = number, max = number })
  default     = { min = 2, max = 4 }

  validation {
    condition     = var.api_replicas.min >= 2 && var.api_replicas.max >= var.api_replicas.min && var.api_replicas.max <= 10
    error_message = "api_replicas: min must be at least 2, max at least min and at most 10 (the database connection budget is sized for 10)."
  }
}

variable "worker_replicas" {
  description = "Minimum and maximum worker replicas. Every worker listens to every notification, so keep the maximum small."
  type        = object({ min = number, max = number })
  default     = { min = 2, max = 3 }

  validation {
    condition     = var.worker_replicas.min >= 2 && var.worker_replicas.max >= var.worker_replicas.min && var.worker_replicas.max <= 6
    error_message = "worker_replicas: min must be at least 2, max at least min and at most 6. Past that, move the queue to Redis or Service Bus."
  }
}

variable "postgres_sku" {
  description = "Flexible Server SKU. Zone-redundant HA needs General Purpose or Memory Optimized; Burstable cannot do it."
  type        = string
  default     = "GP_Standard_D2ds_v5"

  validation {
    condition     = can(regex("^(GP|MO)_", var.postgres_sku))
    error_message = "postgres_sku must be a GP_ or MO_ SKU: zone-redundant high availability is not available on Burstable."
  }
}

variable "postgres_storage_mb" {
  description = "Storage in MB (can grow, cannot shrink)."
  type        = number
  default     = 32768

  validation {
    condition     = contains([32768, 65536, 131072, 262144, 524288, 1048576], var.postgres_storage_mb)
    error_message = "postgres_storage_mb must be one of the Flexible Server storage tiers: 32768, 65536, 131072, 262144, 524288 or 1048576."
  }
}

variable "postgres_backup_retention_days" {
  description = "Point-in-time restore window."
  type        = number
  default     = 14

  validation {
    condition     = var.postgres_backup_retention_days >= 7 && var.postgres_backup_retention_days <= 35
    error_message = "postgres_backup_retention_days must be between 7 and 35."
  }
}

variable "postgres_geo_redundant_backup" {
  description = "Copy backups to the paired region (the disaster-recovery path: restore there). Fixed at creation."
  type        = bool
  default     = true
}

# ------------------------------------------------------------------ operations

variable "alert_email" {
  description = "Who is told when something needs a person."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "monthly_budget_eur" {
  description = "Budget for the resource group; alerts at 80 % and 100 % of actual and 100 % forecast. It does not stop spending."
  type        = number
  default     = 600

  validation {
    condition     = var.monthly_budget_eur > 0
    error_message = "monthly_budget_eur must be positive."
  }
}

variable "log_retention_days" {
  description = "Log Analytics retention."
  type        = number
  default     = 30

  validation {
    condition     = var.log_retention_days >= 30 && var.log_retention_days <= 730
    error_message = "log_retention_days must be between 30 and 730."
  }
}

variable "enable_resource_locks" {
  description = "CanNotDelete locks on the database and the vault. Leave on; remove one deliberately to destroy."
  type        = bool
  default     = true
}

variable "api_image" {
  description = "Server image, by digest: registry/hub-server@sha256:... Built once, promoted between environments, never rebuilt. The first apply may use a placeholder; the pipeline owns it afterwards."
  type        = string
  default     = "mcr.microsoft.com/k8se/quickstart:latest"
}

variable "ai_provider" {
  description = "mock (default), off, or anthropic. anthropic needs the Key Vault secret named in anthropic_secret_name, created out of band."
  type        = string
  default     = "mock"

  validation {
    condition     = contains(["mock", "off", "anthropic"], var.ai_provider)
    error_message = "ai_provider must be mock, off or anthropic."
  }
}

variable "anthropic_secret_name" {
  description = "Name of the Key Vault secret holding the provider key. Only used when ai_provider is anthropic."
  type        = string
  default     = "anthropic-api-key"
}
