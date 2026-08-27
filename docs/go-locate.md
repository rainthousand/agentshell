# Go SDK, IDL, and Generated-Code Locator

The Go locator provides three read-only queries without recursively scanning a user's module cache:

```bash
agentshell go locate symbol Client --package example.org/sdk/client --compact
agentshell go locate dependency example.org/sdk --compact
agentshell go locate generated --kind grpc --compact
```

## Query model

- `symbol` accepts one Go identifier. It uses `go list -deps -json ./...`, then reads only bounded `.go` files named by the returned package metadata. An optional exact package or module-prefix filter narrows the scope.
- `dependency` accepts one exact module or package import path. It resolves only packages already present in the local dependency graph.
- `generated` uses `go list -json ./...` and inspects only files in the current workspace. It recognizes protobuf (`*.pb.go`), gRPC (`*_grpc.pb.go`), common mock generators, Wire (`wire_gen.go`), and the standard generated-file header.

The implementation calls `go env GOMODCACHE` only to classify results as `module-cache`, `local-replace`, or `workspace`. It never recursively walks that directory. Dependency results contain a redacted identity such as `example.org/sdk@v1.2.3/client.go`; they never contain the user's home or module-cache directory.

## Safety and bounds

- Every Go invocation uses an argv array with `shell: false` through the shared bounded-process runner.
- `GOENV=off`, `GOPROXY=off`, `GOSUMDB=off`, `GOTOOLCHAIN=local`, and a fixed `-mod=readonly` prevent network access, inherited Go flag injection, toolchain downloads, and module-file mutation.
- Queries reject flags, globs, path traversal, URIs, shell metacharacters, and empty full-disk searches.
- Package enumeration, process output, file count, per-file bytes, total bytes, result count, and wall-clock time are bounded.
- Results are stable-sorted and paths are either workspace-relative or module-identity based.
- The locator never writes source, module metadata, generated files, or caches.

This module intentionally does not register itself in the public CLI. The command and core interfaces are ready for a separate integration change.
