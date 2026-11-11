output "team_auds" {
  description = "チーム → そのチームのアプリの AUD。deploy.ts が反転して Worker の ACCESS_AUD_MAP にする"
  value       = { for t, app in cloudflare_zero_trust_access_application.team : t => app.aud }
}

output "entry_aud" {
  description = "入口のアプリの AUD（Worker の ACCESS_ENTRY_AUD。どのチームにも対応しない）"
  value       = cloudflare_zero_trust_access_application.entry.aud
}

output "app_ids" {
  description = "アプリ名 → アプリ ID（access-revoke.ts がトークンの失効に使う）"
  value = merge(
    { (cloudflare_zero_trust_access_application.entry.name) = cloudflare_zero_trust_access_application.entry.id },
    { for t, app in cloudflare_zero_trust_access_application.team : app.name => app.id },
  )
}

output "worker_host" {
  description = "Access を掛けたホスト（deploy.ts が AWSBRIDGE_HUMAN_POC_PORTAL_URL と一致するか確かめる）"
  value       = var.worker_host
}
