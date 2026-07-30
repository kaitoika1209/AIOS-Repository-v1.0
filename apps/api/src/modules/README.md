# Backend modules

Each directory is an ownership boundary. Domain and Infrastructure types are private to their module. Only `public.ts` Application contracts may be imported by another module; registered event contracts live in the owning module until deliberately published.

- `identity-organization`
- `work`
- `decision`
- `memory`
- `secretary`
- `operations`
