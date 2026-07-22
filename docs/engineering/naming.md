# Naming Conventions

## Purpose

This document defines the naming conventions used throughout AIOS.

Consistent naming improves readability, reduces ambiguity, and makes the domain easier to understand.

Names should communicate intent rather than implementation.

---

# General Principles

Choose names that describe business concepts.

Avoid names that describe technical implementation.

Names should be easy to understand without additional comments.

When in doubt, choose clarity over brevity.

---

# Language

All source code, identifiers, and documentation should use English.

Business terminology should follow the AIOS domain model.

---

# Naming Rules

## Classes

Use singular nouns.

### Good

```text
Work
Decision
Organization
Member
Memory
Knowledge
Workflow
Capability
```

### Bad

```text
Works
Data
Manager
Handler
Thing
```

---

## Interfaces

Use descriptive names.

Avoid prefixing interfaces with "I".

### Good

```text
WorkRepository
NotificationService
StorageProvider
```

### Bad

```text
IWorkRepository
IData
```

---

## Value Objects

Describe exactly what the value represents.

### Good

```text
WorkId
OrganizationId
EmailAddress
DecisionStatus
```

---

## Enums

Use singular nouns.

Enum values should be descriptive.

### Good

```typescript
enum WorkStatus {
    Draft,
    InProgress,
    Completed,
    Archived
}
```

---

## Methods

Methods should describe behavior.

Use verbs.

### Good

```text
createWork()
complete()
approve()
archive()
assignMember()
```

### Bad

```text
doWork()
handle()
process()
execute()
run()
```

---

## Variables

Use meaningful names.

### Good

```text
work
organization
member
decision
```

### Bad

```text
obj
data
temp
value
item
```

---

## Boolean Variables

Boolean names should read naturally.

### Good

```text
isCompleted
hasPermission
canApprove
shouldNotify
```

### Bad

```text
completed
permission
approveFlag
```

---

# Events

Events describe something that has already happened.

Use past tense.

### Good

```text
WorkCreated
WorkCompleted
DecisionApproved
MemoryGenerated
MemberInvited
```

---

# Commands

Commands represent an intention.

Use imperative verbs.

### Good

```text
CreateWork
ApproveDecision
InviteMember
GenerateMemory
```

---

# Queries

Queries retrieve information.

Begin with verbs such as:

```text
Get
Find
Search
List
```

Examples:

```text
GetWork
FindMember
ListOrganizations
SearchKnowledge
```

---

# Repositories

Repositories are named after the aggregate they manage.

### Good

```text
WorkRepository
DecisionRepository
KnowledgeRepository
```

---

# Services

Services describe business capabilities.

### Good

```text
NotificationService
ReplayService
KnowledgePromotionService
```

Avoid generic names.

### Bad

```text
Manager
Helper
Processor
Util
```

---

# Files

File names should match the primary exported type.

Examples:

```text
work.ts
decision.ts
organization.ts
work.repository.ts
create-work.command.ts
```

Use lowercase with hyphens where appropriate.

---

# API Endpoints

Use nouns instead of verbs.

### Good

```text
POST /works
GET /works
GET /works/{id}
PATCH /works/{id}
DELETE /works/{id}
```

Avoid:

```text
/createWork
/getAllWorks
/updateWork
```

---

# Database Tables

Use plural nouns.

Examples:

```text
organizations
members
works
decisions
memories
knowledge
```

Primary keys should use:

```text
id
```

Foreign keys should use:

```text
organization_id
work_id
member_id
```

---

# Names to Avoid

Avoid vague or generic names.

```text
Data
Info
Object
Manager
Helper
Util
Handler
Processor
Common
Base
Misc
Temp
New
Old
```

If a better name cannot be found, the responsibility is probably unclear.

---

# Consistency

The same concept should always use the same name throughout the project.

For example:

- Work should never also be called Task.
- Member should never also be called User.
- Memory should never also be called History.
- Organization should never also be called Company.

Consistency is more important than personal preference.