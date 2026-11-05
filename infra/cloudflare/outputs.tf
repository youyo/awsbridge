output "mcp_server_id" {
  description = "MCP サーバーの ID。既存の portal を使う場合は portal の servers にこれを足す"
  value       = cloudflare_zero_trust_access_ai_controls_mcp_server.this.id
}

output "worker_access_app_id" {
  description = "Worker 本体を守る self-hosted Access アプリの ID"
  value       = cloudflare_zero_trust_access_application.worker.id
}

output "worker_access_aud" {
  description = "Worker の secret ACCESS_AUD に設定する値（mise.local.toml の AWSBRIDGE_ACCESS_AUD）"
  value       = cloudflare_zero_trust_access_application.worker.aud
}

output "well_known_bypass_app_id" {
  description = "/.well-known/* を bypass する Access アプリの ID"
  value       = cloudflare_zero_trust_access_application.well_known_bypass.id
}

output "mcp_access_app_id" {
  description = "mcp 型 Access アプリの ID"
  value       = cloudflare_zero_trust_access_application.mcp.id
}

output "mcp_access_aud" {
  description = "mcp 型 Access アプリの AUD。STS の信頼や ACCESS_AUD には使わない"
  value       = cloudflare_zero_trust_access_application.mcp.aud
}

output "portal_access_app_id" {
  description = "ポータルの Access アプリの ID（create_portal = true のときだけ）"
  value       = one(cloudflare_zero_trust_access_application.portal[*].id)
}

output "portal_url" {
  description = "ポータルの URL（create_portal = true のときだけ）"
  value       = var.create_portal ? "https://${var.portal_hostname}/mcp" : null
}
