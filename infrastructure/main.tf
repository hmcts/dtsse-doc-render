data "azurerm_key_vault" "key_vault" {
  name                = "${var.product}-${var.env}"
  resource_group_name = "${var.product}-${var.env}"
}

resource "random_password" "doc_render_access_key" {
  length  = 40
  special = false
}

resource "azurerm_key_vault_secret" "doc_render_access_key" {
  name         = "doc-render-access-key"
  value        = random_password.doc_render_access_key.result
  key_vault_id = data.azurerm_key_vault.key_vault.id
  content_type = "text/plain"
  tags         = var.common_tags
}
