#!/usr/bin/env bash
# Builds the production image exactly as the platform does (the repository Dockerfile) and boots
# both services from it with fake values. A package missing from the image fails here, not in
# production (ERR_MODULE_NOT_FOUND). Needs Docker. Run in CI; run locally with `pnpm docker:smoke`.
#
#   DOCKERFILE_PATH=...  use another Dockerfile (default: ./Dockerfile)
#   DOCKER_BUILD_ARGS=... extra `docker build` arguments
#   DOCKER_RUN_ARGS=...   extra `docker run` arguments
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="noctiv-smoke:$$"
KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
ids=()
cleanup() { for c in "${ids[@]:-}"; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true; done; docker rmi -f "$IMAGE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# shellcheck disable=SC2086
docker build ${DOCKER_BUILD_ARGS:-} -f "${DOCKERFILE_PATH:-Dockerfile}" -t "$IMAGE" .

# Production mode, like the platform, with values that only have to be well-formed.
COMMON=(-e NODE_ENV=production -e DATA_REGION_IN_EU=true -e "CREDENTIALS_PUBLIC_KEY=$KEY" -e "ACTION_LINK_SECRET=$SECRET"
  -e SHOPIFY_APP_CLIENT_ID=smoke-client-id -e SHOPIFY_APP_CLIENT_SECRET=smoke-client-secret)
fail=0

boot() { # name, SERVICE, extra env...
  local name="$1" service="$2"; shift 2
  # shellcheck disable=SC2086
  local id; id="$(docker run -d ${DOCKER_RUN_ARGS:-} -e "SERVICE=$service" "${COMMON[@]}" "$@" "$IMAGE")"
  ids+=("$id")
  echo "== $name: started, waiting for it to boot"
  for _ in $(seq 1 30); do
    sleep 1
    if [ "$(docker inspect -f '{{.State.Running}}' "$id")" != "true" ]; then
      # The worker needs a database. With the fake one it stops at its first query; that is a pass
      # because every module was found and the configuration was accepted. Anything else is not.
      if [ "$service" = worker ] && docker logs "$id" 2>&1 | grep -qE 'ECONNREFUSED' \
        && ! docker logs "$id" 2>&1 | grep -qE 'ERR_MODULE_NOT_FOUND|Cannot find (package|module)|SyntaxError|EnvError'; then
        echo "ok $name: modules and configuration load, it stopped at the (fake) database connection"; return
      fi
      echo "!! $name exited:"; docker logs "$id" 2>&1 | tail -20; fail=1; return
    fi
    if [ "$service" = api ] && docker exec "$id" node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      echo "ok $name: /healthz answers"; return
    fi
  done
  if [ "$service" = api ]; then echo "!! $name never answered /healthz:"; docker logs "$id" 2>&1 | tail -20; fail=1; return; fi
  # The worker has no HTTP port: it must still be running after 10 s and have logged no crash.
  if docker logs "$id" 2>&1 | grep -qE 'ERR_MODULE_NOT_FOUND|Cannot find (package|module)|SyntaxError'; then
    echo "!! $name logged a module error:"; docker logs "$id" 2>&1 | tail -20; fail=1; return
  fi
  echo "ok $name: still running after 30 s"
}

boot api api -e API_PORT=8080 -e API_DATABASE_URL=postgres://u:p@127.0.0.1:1/db -e SUPABASE_URL=https://smoke.invalid
boot worker worker -e WORKER_DATABASE_URL=postgres://u:p@127.0.0.1:1/db -e "CREDENTIALS_PRIVATE_KEY=$KEY" \
  -e SYSTEM_MAILER_PENDING=true -e ADMIN_EMAIL=admin@example.com -e GEMINI_API_KEY=smoke-key

exit "$fail"
