terraform {
  required_version = ">= 1.15.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.27.0"
    }
  }

  # backend はローカル（このディレクトリの terraform.tfstate。gitignore 済み）。infra/cloudflare とは別の state。
}

# 認証は環境変数 CLOUDFLARE_API_TOKEN で渡す。
provider "cloudflare" {}
