# Experimental Firebird modifications

This is a modified Prisma Client build based on Prisma ORM 7.10.1, prepared on 2026-10-18.

The build includes a distinct Firebird query compiler and provider, positional raw-query parameters,
Firebird driver-adapter contracts, database error handling, tracing, query batching, and transaction
isolation support. Firebird support is experimental and targets Firebird 3.0 on Node.js.

The subsequent local milestone adds native Int/BigInt identity IDs, DEFAULT VALUES, nested
generated IDs, and atomic createMany using individual parameterized INSERT statements.
Firebird 3 does not expose createManyAndReturn or skipDuplicates in this implementation.
The 45 Client scenarios (47 Node tests including two parents) passed on synthetic Firebird 3.0.14.

The upstream work is distributed under the Apache License, Version 2.0; see `LICENSE`. The source
repository's root `MODIFICATIONS.md` records the broader Firebird implementation and provenance.

`THIRD_PARTY_NOTICES.txt` reproduces observed dependency license texts and retained copied-code
attributions for the Node runtime, with explicit provenance limits.
