# Experimental Firebird adapter additions

Added on 2026-10-18 and modified on 2026-10-19 for the Prisma ORM 7.10.1 Firebird
fork. This package adds attachment-pool and transaction ownership, statement-local
exact-value codecs, native error mapping, SQL-script execution, verified local
shadow connections, migration metadata and focused tests. The explicit
`readCommittedRecordVersion` option preserves the RECORD_VERSION default and
allows NO RECORD_VERSION for default/READ COMMITTED transactions. Lock waits in
seconds remain separate from Prisma transaction budgets in milliseconds.

The package's Apache-2.0 LICENSE is copied unchanged from Prisma ORM. Source files
carry addition/modification notices. The external `node-firebird` dependency is
pinned to 2.18.2, used unchanged, and retains its MPL-2.0 source and LICENSE in the
installed dependency. Its source is not incorporated into the adapter bundle.
The adapter relies on its exported wire modules and prepared-statement descriptors.

See [README.md](README.md) for supported values, transaction and shadow boundaries.
The paired schema validator, query compiler and schema-engine Wasm builds are
required. There is no prepared/distributed 2PC API or verified Firebird 4/5 support.
Historical package notices and acceptance evidence remain separately preserved;
this source notice does not certify a new package release or production use.
