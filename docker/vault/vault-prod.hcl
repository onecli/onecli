ui = true

disable_mlock = true

api_addr = "http://vault-prod:8200"
cluster_addr = "http://vault-prod:8201"

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = 1
}

storage "raft" {
  path    = "/vault/file"
  node_id = "vault-prod-1"
}
