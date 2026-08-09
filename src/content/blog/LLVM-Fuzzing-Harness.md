---
title: "Building a Standalone LLVM Fuzzing Harness for Apache mod_http2: Understanding Memory Ownership Through Source-Level Analysis"
description: "A practical walkthrough of building an isolated LLVM fuzzing harness for Apache mod_http2 and using source-level analysis to validate memory ownership assumptions."
date: 2026-07-19
---

# Building a Standalone LLVM Fuzzing Harness for Apache mod_http2: Understanding Memory Ownership Through Source-Level Analysis

Memory lifetime bugs are among the most challenging classes of defects to investigate in large C codebases. While the underlying concepts such as ownership, aliasing, and object lifetime are well understood, following those properties through a mature software project often requires navigating thousands of lines of infrastructure code before reaching the behavior of interest.

Traditional fuzzing approaches exercise the application as a whole, but this comes at a cost. Network stacks, logging, configuration parsing, thread scheduling, and initialization logic all become part of every execution, making it harder to isolate the subsystem being studied and to reason about unexpected behavior.

A useful alternative is to build a standalone fuzzing harness around a single component. Instead of launching the complete application, the harness recreates only the minimal runtime required by the target function, replacing the remaining dependencies with lightweight stubs. This dramatically reduces execution time while giving the researcher complete control over memory allocation, buffer ownership, and execution flow.

This article describes the construction of such a harness for Apache HTTP Server's `mod_http2`. Rather than attempting to demonstrate a vulnerability, the objective is to understand how data moves through the output pipeline, how memory ownership changes between subsystems, and how those assumptions can be validated directly from the source code. The resulting harness executes a single isolated `mod_http2` code path without starting Apache itself, making it possible to observe memory ownership transitions under controlled conditions.

During that process, we will encounter several situations where apparently reasonable assumptions about memory ownership prove incorrect once the execution is traced into APR itself. Those moments are not failures; they are a natural consequence of source-level security research, where intuition must continually be verified against the implementation.

Along the way, we will use this harness to implementing the standard `LLVMFuzzerTestOneInput` interface, discuss practical techniques for mocking Apache internals without starting the full server, examine the interaction between APR pools and bucket allocators, and analyze how implementation changes across Apache releases affect the observable behavior of the same harness.

The goal is therefore methodological rather than vulnerability-oriented: to demonstrate a repeatable approach for isolating, instrumenting, and understanding complex C components using source-guided fuzzing.

*Note:* This article focuses on defensive software testing techniques and reverse engineering of memory ownership. It does not discuss exploit development or offensive techniques.

## Why Build a Standalone Harness?

One of the main challenges when analyzing a subsystem inside Apache HTTP Server is that the code of interest normally executes as part of a much larger runtime environment.

A typical request passes through connection setup, protocol negotiation, filters, logging, scheduler decisions, and several layers of APR infrastructure before reaching the functions we want to study. When fuzzing the complete server, every one of those components becomes part of each test iteration.

When studying a specific execution path, that environment introduces more complexity than value. Unexpected behavior becomes harder to explain because many unrelated components can influence the final result.

A standalone harness takes a different approach.

Instead of reproducing an entire HTTP transaction, it recreates only the minimal execution context required by the target function. The harness allocates the necessary APR objects, constructs lightweight replacements for the surrounding Apache structures, invokes the function under test directly, and inspects the resulting state.

Once this minimal environment is available, it can be connected to an LLVM-compatible fuzzing engine. Rather than generating complete HTTP requests, the fuzzer mutates the input buffer passed to the target function while using compiler-generated coverage feedback to explore new execution paths.

```
[ Fuzzer Input ] ---> [ Create Minimal APR Context ] ---> [ Call h2_c1_io_add_data() ] ---> [ Traverse Bucket Brigade ] ---> [ Verify Memory Ownership ]
```

This approach has several advantages. Each execution is deterministic, the amount of initialization code is dramatically reduced, and every observed behavior can be traced back to a small portion of the codebase.

More importantly, isolating the subsystem makes it practical to follow ownership transitions through the implementation, tracing the execution from `mod_http2` into APR itself. This allows us to focus on a single function, inspect each subsequent call, and verify how buffers move across APR's abstractions.

Beyond simplifying manual analysis, the same isolation also makes coverage-guided fuzzing substantially more effective. Each iteration begins from a minimal, deterministic execution context, allowing the fuzzer to spend its effort exploring the target code rather than repeatedly traversing unrelated Apache initialization paths. The result is not merely faster execution, but a much higher proportion of useful mutations reaching the subsystem under investigation.

The resulting harness therefore serves both as a reproducible analysis environment and as an efficient execution target for coverage-guided fuzzing.

## Understanding APR Memory Pools and Bucket Brigades

Before looking at the harness itself, it is useful to understand the two Apache Portable Runtime (APR) abstractions that dominate the execution path explored in this article: memory pools and bucket brigades.

Unlike many C applications, Apache HTTP Server does not rely exclusively on individual `malloc()` and `free()` calls. Instead, most allocations are grouped into memory pools (`apr_pool_t`), while data flowing through the server is represented using bucket brigades (`apr_bucket_brigade`).

These abstractions simplify memory management and reduce allocation overhead, but they also make ownership and object lifetime less obvious when reading the code.

For the execution path analyzed in this article, two abstractions are particularly important:

* **Memory Pools** (`apr_pool_t`). Objects allocated from a pool remain valid until that pool is destroyed. Rather than freeing individual allocations, Apache typically releases an entire pool at once when the corresponding scope ends, such as the lifetime of a request or connection.

* **Bucket Brigades** (`apr_bucket_brigade`). Response data is transported through the server as a linked list of buckets. Each bucket represents a fragment of the output stream, but different bucket implementations manage their underlying storage differently. Some buckets own their memory, others reference existing buffers, and others generate data on demand.

Throughout this article, we will primarily focus on heap buckets because they are the bucket type generated along the execution path exercised by the harness.

Understanding which component owns a particular buffer is essential when reasoning about memory lifetime. Similar-looking APIs may have very different ownership semantics, and those semantics are not always obvious from the call site alone.

One of the goals of this article is to verify those ownership assumptions by tracing the execution path into the APR implementation itself, rather than relying solely on intuition or API naming.

### Why Ownership Matters

At first glance, it is tempting to assume that passing a pointer to a bucket API simply stores that pointer for later use. If that were true, destroying the original allocation before the bucket was consumed would immediately create a dangling reference.

However, that behavior cannot be determined by inspecting the caller alone.

Whether a pointer is stored directly, copied into newly allocated memory, or transformed into another representation depends entirely on the implementation of the bucket type involved.

As we will see later, tracing that implementation step by step turns out to be one of the most valuable parts of the analysis. Rather than relying on intuition, we can verify ownership semantics by combining the observations produced by the harness with a source-level analysis of APR.

### The LLVM Fuzzing Harness

In practice, each fuzzing iteration follows the same sequence of steps. It creates a minimal APR execution context, passes the mutated input directly to `h2_c1_io_add_data()`, inspects the resulting bucket brigade, and finally destroys the temporary pools before the next iteration begins. The overall control flow is intentionally simple:

```c
extern "C"
int LLVMFuzzerTestOneInput(const uint8_t *Data,
                           size_t Size) 
{
    if (Size == 0 || Size > 65536)
        return 0;

    apr_pool_t *server_pool;
    apr_pool_t *request_pool;

    /* Create server_pool and its child request_pool. */

    ...

    /* Construct the minimal h2_c1_io object */

    h2_c1_io io =
        create_minimal_io(server_pool,
                          request_pool);
    
    /* Execute the target function */

    h2_c1_io_add_data(&io,
                      (const char *)Data,
                      Size);
    
    /* Inspect the resulting bucket brigade */

    inspect_bucket_brigade(io.output);
    
    ...

    apr_pool_destroy(server_pool);

    return 0;
}
```

For clarity, the code omits one-time initialization performed by `LLVMFuzzerInitialize()`. In the actual implementation, APR is initialized only once when the fuzzer starts, while each iteration creates only the temporary pools required for the that execution.

Notice that the mutated input is delivered directly to `h2_c1_io_add_data()`. No HTTP parser, socket layer, or request processing pipeline is involved, allowing the fuzzer to exercise the target function in complete isolation.

The actual implementation contains additional linker stubs and minimal Apache object initialization required to execute `mod_http2` outside the HTTP Server runtime. Those implementation details have been omitted here to keep the discussion focused on the execution flow rather than the surrounding infrastructure.

Despite the amount of supporting code required to satisfy Apache's dependencies, the fuzzing loop itself remains remarkably small. Once the execution environment has been constructed, each iteration performs only four essential operations: create a fresh execution context, invoke the target function with the mutated input, inspect the resulting bucket brigade, and destroy the temporary pools. This simplicity is somewhat deceptive: the real engineering challenge lies not in the fuzzing loop itself, but in recreating just enough of Apache's runtime for that loop to execute deterministically.

### Isolating the Target: Satisfying Apache's Dependencies

Although `h2_c1_io.c` contains the logic under investigation, compiling it as a standalone translation unit is rarely straightforward. Like many Apache modules, it depends on numerous symbols provided by the rest of the HTTP Server codebase.

Some of these dependencies are ordinary functions, while others are global variables, module descriptors, or configuration helpers that normally become available only when building the entire server.

Rather than compiling the entire Apache HTTP Server, the harness provides minimal implementations of only the symbols required by the linker:

```c
const char *ap_get_server_built(void)
{
    return "Harness";
}

int h2_session_dispatch_event(void *session,
                              int ev,
                              int err,
                              const char *msg)
{
    return 0;
}
```

Most of these functions are never actually executed along the code path analyzed in this article. They exist solely because the linker requires every referenced symbol to be resolved.

The stub implementations are not intended to reproduce the complete behavior of Apache. Their purpose is simply to satisfy symbol resolution and allow the target execution path to execute successfully.

This approach keeps the harness intentionally minimal. Functions that are never reached during the analysis can safely return fixed values or perform no work at all, reducing both compilation complexity and maintenance effort.

As the harness evolves, additional stubs can be introduced as new execution paths begin exercising other parts of the Apache codebase. This allows the environment to grow alongside the analysis instead of attempting to recreate the entire server upfront.

### Struct Layout Drift and Minimal Session Objects

Once the harness links successfully, another practical problem appears: constructing enough of Apache's internal objects for the target function to execute.

`h2_c1_io_add_data()` is not completely self-contained. Before reaching the output logic, the function (and its surrounding infrastructure) may dereference members of the associated `h2_session` object, primarily to obtain the active connection (`conn_rec`) referenced by other parts of the module.

One possibility would be to construct a genuine `h2_session` instance and populate its fields according to Apache's internal definitions. That approach, however, tightly couples the harness to a specific source layout. Even small structural changes between releases can shift field offsets and require version-specific initialization code.

Instead, the harness treats `h2_session` as an opaque object. Rather than reconstructing the complete structure, it allocates a zero-initialized block of memory and populates only the pointer-sized slots required by the execution path under investigation. Because the generated machine code dereferences fixed offsets rather than interpreting C structure definitions, this approach proved sufficiently resilient to the layout changes observed across the Apache releases examined during this investigation while avoiding unnecessary dependence on Apache's internal object layout.

```c
conn_rec *mock_c = apr_pcalloc(server_pool, sizeof(conn_rec));

mock_c->pool = server_pool;
mock_c->bucket_alloc = server_alloc;

void **mock_session_raw =
    (void **)apr_pcalloc(server_pool, 1024);

mock_session_raw[0] = mock_c;
mock_session_raw[1] = mock_c;
mock_session_raw[2] = mock_c;

io.session = (struct h2_session *)mock_session_raw;
```

This technique deliberately avoids reconstructing the complete structure. Instead, it satisfies only the fields that are actually accessed along the execution path being studied.

The required layout was determined empirically through GDB-assisted debugging. By observing the offsets involved in failed dereferences, it became possible to identify where the compiled code expected to find a valid connection pointer. Populating the required pointer-sized slots proved sufficient for the execution paths analyzed across the Apache releases used during this investigation.

From the processor's perspective, this behavior is entirely natural. The generated machine code does not interpret C structure definitions. Instead, it performs memory accesses at fixed offsets relative to a base address. If the instruction requests the pointer located eight bytes after the start of the object, the processor performs exactly that memory access regardless of how the original C structure was declared.

By placing the same valid pointer at the required pointer-sized offsets, the harness tolerates small layout differences without requiring multiple versions of the same mock object.

This approach intentionally trades structural accuracy for reduced coupling to Apache's internal layout. If future versions of Apache begin dereferencing previously unused fields, the harness may terminate because of incomplete mock objects rather than genuine defects. Such crashes should therefore be interpreted carefully and distinguished from vulnerabilities in the target code itself.

This technique is not intended to replace real data structures in general. Instead, it is a pragmatic solution for isolated harnesses, where only the subset of fields exercised by the target execution path is actually required.

## Comparing the Output Path Across Apache Releases

One interesting observation when comparing different Apache HTTP Server releases is that the implementation of `h2_c1_io_add_data()` changed significantly over time.

In Apache 2.4.58 the function contains two distinct execution paths. Depending on the value of `buffer_output`, response data is either accumulated in an intermediate scratch buffer or forwarded to `apr_brigade_write()`.

```c
if (io->buffer_output) 
{
    /* Append to the scratch buffer */
}
else 
{
    status = apr_brigade_write(io->output, NULL, NULL, data, length);
    io->buffered_len += length;
}
```

Comparing Apache 2.4.58 with 2.4.68 shows that the conditional path is no longer present in the latter. Response data is always accumulated in the internal scratch buffer before progressing through the rest of the output pipeline.

At first glance, the older implementation appears to forward a caller-owned buffer directly into the bucket brigade, making it tempting to assume that the brigade stores that pointer for later use.

However, that assumption cannot be validated by inspecting `h2_c1_io_add_data()` alone.

Following the execution through the APR implementation reveals that `apr_brigade_write()` eventually creates a heap bucket through `apr_bucket_heap_create()`, which in turn delegates to `apr_bucket_heap_make()`.

```text
h2_c1_io_add_data() -> apr_brigade_write() -> apr_bucket_heap_create() -> apr_bucket_heap_make() 
                                                                              +--> apr_bucket_alloc()
                                                                              |
                                                                              +--> memcpy()
```

When no custom deallocation function is provided, `apr_bucket_heap_make()` allocates its own storage and copies the supplied data:

```c
h->base = apr_bucket_alloc(h->alloc_len, b->list);
memcpy(h->base, buf, length);
```

This implementation detail is crucial because it fundamentally changes the ownership model. Although the caller passes a pointer to `apr_brigade_write()`, the resulting heap bucket owns an independent copy of the data rather than retaining the original pointer.

This illustrates an important lesson for source-level analysis: ownership semantics cannot always be inferred from API boundaries. Understanding whether memory is copied, referenced, or transferred requires following the execution through the underlying implementation instead of relying solely on the apparent behavior of the calling code.

Methodological note. The comparison presented here is limited to Apache 2.4.58 and Apache 2.4.68, which was the latest Apache HTTP Server release available at the time of writing. Intermediate releases were not analyzed, so this article does not attempt to identify the exact version in which the implementation changed.

## Instrumenting the Harness: Observing Memory Ownership

Once the harness can execute the target path deterministically, the next challenge is making memory ownership easier to observe during debugging.

Destroying an APR memory pool immediately invalidates every allocation associated with that pool, but it does not necessarily overwrite the underlying bytes. Depending on the allocator's behavior, the released memory may remain unchanged until it is reused.

To make allocator reuse more visible, the harness performs several large allocations immediately after destroying the request pool:

```c
size_t spray_size = (Size > 8192) ? Size : 8192;

for (int i = 0; i < 3; i++) 
{
    char *dirty_memory = apr_palloc(server_pool, spray_size);
    memset(dirty_memory, 'X', spray_size);
}
```

The harness therefore does not rely on this allocator reuse for correctness; the additional allocations merely increase the chances of observing it during debugging.

Whether previously released blocks are actually recycled depends on APR's allocation strategy and on the allocation pattern exercised by the harness. This should therefore be viewed as an instrumentation technique rather than a deterministic property of APR's allocator.

### A Deterministic Validation Oracle

After the target function completes, the harness walks the resulting bucket brigade and inspects the data exposed by each bucket:

```c
apr_status_t rv =
    apr_bucket_read(b, &str, &len, APR_BLOCK_READ);

if (rv == APR_SUCCESS && len > 0 && str != NULL) 
{
    if (str[0] == 'X') 
    {
        __builtin_trap();
    }
}
```

The validation oracle is intentionally simple. If the first byte returned by `apr_bucket_read()` matches the recognizable byte pattern introduced earlier, execution stops immediately through `__builtin_trap()`, allowing the current program state to be inspected under a debugger or captured by the fuzzing engine.

Unlike AddressSanitizer, this oracle is not intended to detect memory safety violations directly. Its objective is different. Rather than detecting arbitrary memory corruption, it answers a specific question about the execution path under investigation. Does the bucket brigade continue exposing the original request buffer after the request pool has been destroyed, or has APR already taken ownership by creating an independent copy? 

Because the expected ownership transition is known in advance, a simple deterministic check is sufficient for this particular investigation. It therefore serves as a deterministic observation point for validating assumptions about the execution path under investigation.

As part of the instrumentation, the harness also reports the concrete bucket type returned by APR. Across the executions performed during this investigation, APR creates `HEAP` buckets before the ownership checks are performed, matching the implementation described above.

For debugging purposes, the harness also prints both the original request buffer and the pointer returned by `apr_bucket_read()`. The two addresses consistently differ, demonstrating that the bucket exposes APR-managed storage rather than the original request allocation.

These observations alone do not establish whether the bucket owns the original buffer or an independent copy. Answering that question requires comparing the addresses exposed by the harness and then tracing the implementation into APR.

Explaining these observations requires following the implementation into APR itself. Tracing the execution from `apr_brigade_write()` through `apr_bucket_heap_create()` and finally into `apr_bucket_heap_make()` shows that this execution path allocates heap-owned storage and copies the supplied buffer before inserting the bucket into the brigade.

The runtime observations complement the source-level analysis rather than replacing it. The printed addresses suggest that ownership has changed, while the APR implementation explains precisely why that transition occurs.

More generally, this illustrates an important principle when building fuzzing harnesses: instrumentation can highlight interesting execution states, but correctly interpreting those states requires validating the implementation underneath rather than relying solely on observed behavior.

### Limitations of the Oracle

Validation oracles such as the one presented here are useful for validating ownership assumptions, but they should not be viewed as a replacement for memory sanitizers.

Apache's APR pools implement a custom allocation strategy in which many allocations are released when an entire pool is destroyed rather than through ordinary `free()` calls. As a result, generic memory sanitizers may require additional allocator annotations to precisely model object lifetime in pool-managed memory.

Those considerations fall outside the scope of this article, whose objective is to understand ownership rather than maximize bug detection.

Production fuzzing environments often complement instrumentation with AddressSanitizer and, where appropriate, explicit poisoning APIs such as `__asan_poison_memory_region()` to improve the detection of pool-related lifetime errors.

## Verifying the Ownership Transition at Runtime

During development, the harness prints the bucket type, the original request buffer, and the pointer returned by `apr_bucket_read()`:

```text
bucket type    = HEAP

request_payload = 0x7f8424034038
bucket_data     = 0x555732e6fe68
```

The printed addresses are diagnostic output produced by the harness solely to validate ownership assumptions during development; they are not part of the fuzzing logic itself.

Combined with the source-level inspection of `apr_bucket_heap_make()`, these runtime observations confirm that the bucket brigade exposes APR-managed heap storage rather than the original request buffer.

## Conclusion: What Harness Isolation Teaches Us About Software Architecture

Building an isolated harness for a small part of a large codebase is far more than a convenient fuzzing technique. It is a practical way to understand how complex software actually works.

By removing networking, configuration parsing, logging, and other unrelated infrastructure, the execution becomes easier to reason about. Instead of debugging an entire application, we can focus on a single component, observe its behavior under controlled conditions, and follow its interactions all the way down to the underlying implementation.

Minimizing the execution environment proved to be one of the most valuable design decisions. Rather than reproducing Apache's complete runtime, only the subset of objects required by the execution path under investigation needed to be constructed, making the resulting behavior significantly easier to reason about.

Instrumentation proved more useful as an observation mechanism than as a bug detector. Heap poisoning, logical oracles, and runtime diagnostics exposed interesting execution states, but those observations only became meaningful after validating them against the underlying APR implementation.

Following the implementation beyond API boundaries was equally important. An apparently plausible ownership model at the call site was disproved once the execution was traced into APR's bucket implementation, illustrating why source-level validation is essential when reasoning about memory lifetime.

Finally, deterministic harnesses greatly simplify both experimentation and debugging. Once the execution path can be reproduced in isolation, fuzzers, debuggers, and sanitizers all become more effective because every run exercises the same well-defined sequence of operations.

Perhaps the most important lesson is methodological. A harness should not be viewed as a tool that proves the existence of a bug. Instead, it provides a controlled environment for testing hypotheses about a program's behavior.

Although this article focused on a small part of Apache mod_http2, the methodology presented here applies equally well to many large C and C++ projects. Careful isolation, lightweight instrumentation, and source-level validation make it possible to reason about complex execution paths without reproducing an entire application.

Even when an initial hypothesis turns out to be incorrect, the process produces a more accurate understanding of the software.

Ultimately, the implementation itself is the only reliable source of truth.
