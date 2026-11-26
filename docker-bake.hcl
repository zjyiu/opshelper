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
  context = "deploy/dsh-runtime"
  tags    = ["opshelper/dsh-runtime:0.2.2-rc.5-r1"]
}
