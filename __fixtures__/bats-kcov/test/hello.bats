#!/usr/bin/env bats

setup() {
  bats_load_library bats-support
  bats_load_library bats-assert
}

@test "greets the world by default" {
  run bash "${BATS_TEST_DIRNAME}/../hello.sh"
  assert_success
  assert_output "hello world"
}

@test "greets a named argument" {
  run bash "${BATS_TEST_DIRNAME}/../hello.sh" bats
  assert_success
  assert_output "hello bats"
}
