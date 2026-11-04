output "management_groups" {
  description = "Management group ids, by place in the hierarchy."
  value       = local.scope_ids
}

output "workload_scope_prod" {
  description = "The management group a production workload subscription belongs under (set through var.subscriptions.prod)."
  value       = azurerm_management_group.prod.id
}
