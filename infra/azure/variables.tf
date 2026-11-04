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

# ------------------------------------------------------------------ events, agents and readers

variable "consumer_sets" {
  description = <<-EOT
    One Container App per set of event consumers (the local twin's notifier and agents services). Adding a
    future agent or consumer is one more entry here: consumers is the REACTOR_CONSUMERS list of that process
    (a consumer id such as notifier or agent:<id>), agents lists the agents it auto-runs. The union of every
    set's agents becomes AGENTS in all processes (the one that writes an event decides who gets it), so the
    api and worker pick it up from the same entry; nothing else changes. The default runs the pre-check on every
    submit: with ai_provider = "anthropic" that costs a model call each time, so drop `agents` from that entry
    to keep it on demand only. Replicas are safe at any count (deliveries are leased); the maximum is
    capped because every process holds database connections (pool of 3 each).
  EOT
  type = map(object({
    consumers    = string
    agents       = optional(string)
    min_replicas = optional(number, 1)
    max_replicas = optional(number, 2)
    cpu          = optional(number, 0.25)
    memory       = optional(string, "0.5Gi")
  }))
  default = {
    notifier = { consumers = "notifier" }
    agents   = { consumers = "agent:precheck", agents = "precheck" }
  }

  validation {
    condition     = alltrue([for k, s in var.consumer_sets : can(regex("^[a-z][a-z0-9-]{1,11}$", k)) && length(trimspace(s.consumers)) > 0 && s.min_replicas >= 1 && s.max_replicas >= s.min_replicas])
    error_message = "consumer_sets: names are 2-12 lowercase letters, digits or hyphens; consumers must name at least one consumer (an empty list would run every consumer in every set); min_replicas is at least 1 (there is no event to wake a scaled-to-zero poller) and at most max_replicas."
  }

  validation {
    condition     = sum([for s in var.consumer_sets : s.max_replicas]) <= 6
    error_message = "consumer_sets: at most 6 replicas in total, which is what the database connection budget leaves after the api and workers (docs/SIZING.md)."
  }
}

variable "enable_reader_email" {
  description = "Create Azure Communication Services Email (Azure-managed sender domain) and let the app identity send through it. false sets EMAIL_TRANSPORT=off: the public form then offers webhooks only."
  type        = bool
  default     = true
}

variable "communication_data_location" {
  description = "Where Communication Services stores its data. Must be a geography, not a region (Europe, UK, United States...)."
  type        = string
  default     = "Europe"
}

variable "reader_token_secret_name" {
  description = "Key Vault secret (32+ random characters, created out of band like the provider key) from which confirmation, unsubscribe and webhook-signing secrets are derived. Rotating it invalidates unsubscribe links already sent."
  type        = string
  default     = "reader-token-key"
}

variable "enable_front_door" {
  description = "Azure Front Door Standard in front of the API: caches the public reads (the archive and the Atom feed), applies a rate limit to the subscription form at the edge. false serves the container app ingress directly."
  type        = bool
  default     = true
}

variable "edge_subscribe_rate_limit_per_minute" {
  description = "Subscription form posts allowed per client address per minute at the Front Door edge (the API also limits, 5 an hour per client)."
  type        = number
  default     = 20

  validation {
    condition     = var.edge_subscribe_rate_limit_per_minute >= 1
    error_message = "edge_subscribe_rate_limit_per_minute must be at least 1."
  }
}

# ------------------------------------------------------------------ private network, edge, disaster recovery

variable "private_data_plane" {
  description = "Registry (Premium) and Key Vault reachable only through private endpoints, builds in a registry agent pool inside the network, outbound traffic through one NAT gateway with a known address. false keeps the cheaper public-with-firewall setup (dev)."
  type        = bool
  default     = true
}

variable "private_ingress" {
  description = "Front Door Premium reaches the Container Apps environment over Private Link and the environment has no public address, so the only way in is the edge (and its WAF). Needs enable_front_door. The connection must be approved once: scripts/approve-private-link.sh."
  type        = bool
  default     = true
}

variable "key_vault_allowed_ips" {
  description = "Public addresses that may reach the vault's data plane while private_data_plane is on (an operator creating the first secrets). Empty keeps the vault closed to the internet."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for ip in var.key_vault_allowed_ips : can(cidrhost(length(split("/", ip)) == 1 ? "${ip}/32" : ip, 0))])
    error_message = "key_vault_allowed_ips entries must be IPv4 addresses or CIDR ranges."
  }
}

variable "edge_id_mode" {
  description = "log: a request without the right X-Azure-FDID is logged and served, so the header can be proven in the first deploy; enforce: it is refused with 403. Start with log, read the app log for 'edge id', then set enforce. With private_ingress the network already blocks the direct path, so this is a second lock."
  type        = string
  default     = "log"

  validation {
    condition     = contains(["log", "enforce"], var.edge_id_mode)
    error_message = "edge_id_mode must be log or enforce."
  }
}

variable "waf_managed_rules" {
  description = "Attach Microsoft's managed rule sets (default rule set and bot manager) to the Front Door WAF. Needs the Premium tier, which this turns on."
  type        = bool
  default     = true
}

variable "waf_managed_rules_action" {
  description = "Log first: read FrontDoorWebApplicationFirewallLog for a week against real traffic, add exclusions for false positives, then Block."
  type        = string
  default     = "Log"

  validation {
    condition     = contains(["Log", "Block"], var.waf_managed_rules_action)
    error_message = "waf_managed_rules_action must be Log or Block."
  }
}

variable "dr_location" {
  description = "Second region for disaster recovery (null = none). A PostgreSQL read replica and the container apps run there, Front Door sends traffic to it only when the primary region fails its probe. Must be an availability-zone region and not the primary one."
  type        = string
  default     = null

  validation {
    condition     = var.dr_location == null || contains(["uksouth", "northeurope", "westeurope", "swedencentral", "francecentral", "germanywestcentral"], coalesce(var.dr_location, "x"))
    error_message = "dr_location must be null or one of uksouth, northeurope, westeurope, swedencentral, francecentral, germanywestcentral."
  }
}

variable "dr_address_space" {
  description = "VNet CIDR of the second region: a /22 that overlaps neither address_space nor anything it is peered with."
  type        = string
  default     = "10.41.0.0/22"

  validation {
    condition     = can(cidrhost(var.dr_address_space, 0)) && tonumber(split("/", var.dr_address_space)[1]) == 22
    error_message = "dr_address_space must be a /22."
  }
}

variable "dr_postgres_sku" {
  description = "SKU of the replica. It becomes the primary after a failover, so size it like the primary; null uses postgres_sku. A replica cannot have high availability until it is promoted."
  type        = string
  default     = null
}

variable "read_replica" {
  description = "Run a second PostgreSQL replica in the primary region for the public reads (READ_DATABASE_URL). Turn it on when the database CPU alert fires on public traffic (docs/adr/0001)."
  type        = bool
  default     = false
}
