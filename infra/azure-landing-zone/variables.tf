variable "org" {
  description = "Short organisation name: the name of the top management group and the prefix of every group under it."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,15}$", var.org))
    error_message = "org must be 3 to 16 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "org_display_name" {
  description = "Name shown in the portal for the top management group."
  type        = string
}

variable "parent_management_group_id" {
  description = "Management group the hierarchy hangs from. null puts it directly under the tenant root group."
  type        = string
  default     = null
}

variable "subscriptions" {
  description = "Subscription ids per place in the hierarchy. platform: shared services (connectivity, identity, management); prod and nonprod: workloads such as Disclosure Hub (infra/azure), one subscription per environment; sandbox: experiments. Moving a subscription is a one-line change here."
  type = object({
    platform = optional(list(string), [])
    prod     = optional(list(string), [])
    nonprod  = optional(list(string), [])
    sandbox  = optional(list(string), [])
  })
  default = {}

  validation {
    condition     = alltrue([for s in concat(var.subscriptions.platform, var.subscriptions.prod, var.subscriptions.nonprod, var.subscriptions.sandbox) : can(regex("^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", s))])
    error_message = "Every subscription id must be a GUID."
  }

  validation {
    condition     = length(concat(var.subscriptions.platform, var.subscriptions.prod, var.subscriptions.nonprod, var.subscriptions.sandbox)) == length(distinct(concat(var.subscriptions.platform, var.subscriptions.prod, var.subscriptions.nonprod, var.subscriptions.sandbox)))
    error_message = "A subscription can sit under one management group only."
  }
}

variable "enforce_policies" {
  description = "false (default): policies only report non-compliance (Azure Policy shows it per resource; nothing is blocked). true: those that can deny do deny. Start false, read the compliance results for a few weeks, fix or exempt what they find, then set true."
  type        = bool
  default     = false
}

variable "allowed_locations" {
  description = "Regions resources may be created in, plus \"global\" for resources that have no region (Front Door, DNS). Must include every region the workloads use, the second region of a disaster-recovery pair too."
  type        = list(string)
  default     = ["uksouth", "northeurope", "global"]

  validation {
    condition     = contains(var.allowed_locations, "global")
    error_message = "allowed_locations must include \"global\": Front Door and other global resources are created there."
  }
}

variable "required_tags" {
  description = "Tags every resource group must carry (the workload root in infra/azure requires the same two)."
  type        = list(string)
  default     = ["owner", "cost_centre"]
}

variable "rbac" {
  description = "Role assignments for groups at a place in the hierarchy. Use groups, never people; give the narrowest role that does the job. scope is one of org, platform, landing_zones, prod, nonprod, sandbox."
  type = map(object({
    group_object_id = string
    role            = string
    scope           = string
  }))
  default = {}

  validation {
    condition     = alltrue([for k, a in var.rbac : contains(["org", "platform", "landing_zones", "prod", "nonprod", "sandbox"], a.scope)])
    error_message = "rbac scope must be org, platform, landing_zones, prod, nonprod or sandbox."
  }

  validation {
    condition     = alltrue([for k, a in var.rbac : can(regex("^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", a.group_object_id))])
    error_message = "rbac group_object_id must be a GUID (an Entra group)."
  }

  validation {
    condition     = alltrue([for k, a in var.rbac : !(contains(["owner", "user access administrator", "role based access control administrator"], lower(a.role)) && contains(["org", "landing_zones", "prod"], a.scope))])
    error_message = "Owner, User Access Administrator and Role Based Access Control Administrator can all hand out access, so they are not given at org, landing_zones or prod: they pass down to every production subscription. Give Contributor or a custom role, or the privileged role on platform and nonprod only."
  }
}
