## Build and run your first flow

1. In the cockpit, press **+ New Flow** and give it a name.
2. Add **steps**. Each step gets one **agent** (its system prompt) and any number
   of **skills**, plus a description — that's the task the step performs.
3. Declare dependencies (`dependsOn`) and, optionally, **artifact gates**
   (`requires` / `produces`) and a **review gate** (human approve/reject or AI).
4. Press **Run**. Each step opens in a Claude terminal; its output streams into the
   console. A step finishes only when its produced files exist and the review
   passes.

That's the whole loop: **agents + skills → steps → a flow you can run and review.**
