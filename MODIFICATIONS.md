# Experimental Firebird fork modifications

Modified on 2026-10-18, 2026-10-19 and 2026-10-20 from Prisma ORM 7.10.1,
commit `97ea359250335c1a174504c9b2b7e5fe030ab937`.
The upstream Apache-2.0 LICENSE and existing copyright/attribution notices are
preserved. This is an experimental fork, not an upstream Prisma release.

The modifications add a distinct Firebird provider and driver adapter, generated
Client/runtime integration, exact numeric and temporal codecs, parameterized CRUD,
identity and transactional singleton-insert createMany plans, updateable identifiers,
literal-prefix filters, and explicit READ COMMITTED record-version policy. They
also add schema-engine Wasm routing for introspection, schema diff/push and the
supported migration subset, plus an optional Firebird CLI build profile and tests.
Shared lifecycle/disposal, offline datamodel diff and driver-adapter interfaces are
extended where needed by the paired engines implementation.

This source checkout requires the modified engines based on commit
`d1b3f377ca835d73fd50954a5e22128b9ebdd6b8`. Build, usage, compatibility and
transaction boundaries are described in [docs/firebird.md](docs/firebird.md).
The JavaScript driver is the unchanged `node-firebird` 2.18.2 dependency (MPL-2.0);
its [original license](docs/plans/firebird/licenses/node-firebird-2.18.2-LICENSE.txt)
is retained byte-for-byte. The adapter relies on that version's exported wire and
prepared-statement APIs. Client copied-code/dependency attributions remain in
[THIRD_PARTY_NOTICES.txt](packages/client/THIRD_PARTY_NOTICES.txt).

Historical local package staging also projected dependency manifests and bundled
Wasm/dependency legal payloads; those private packages are separate from this
source commit. Their original manifests, artifact-bound license inventories,
modification notices, test output and receipts are preserved in the local archive,
outside version control. Consolidating source documentation does not change the
bytes or claims of those historical packages. Redistribution of new binaries or
packages requires their own complete, matching dependency/legal inventory.

Firebird 3.0.14 Windows x64 has scoped synthetic validation. Firebird 4/5, broad
application compatibility, native Firebird schema-engine CLI and legacy prepared/
distributed 2PC remain unimplemented or unverified as specified in the guide.
Source publication is not a package release, production or compatibility approval.
