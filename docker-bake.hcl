group "default" {
  targets = ["api", "worker", "web", "runtime"]
}

target "api" {
  context = "."
  target  = "api"
  tags    = ["opshelper-api:local"]
}

target "worker" {
  context = "."
  target  = "worker"
  tags    = ["opshelper-worker:local"]
}

target "web" {
  context = "."
  target  = "web"
  tags    = ["opshelper-web:local"]
}

target "runtime" {
  context = "deploy/opencode-runtime"
  tags    = ["opshelper/opencode-runtime:2.0.27"]
}
