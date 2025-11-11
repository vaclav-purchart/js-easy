# Unified Diff Format for AI

The editor now uses **unified diff format** for AI code modifications. This significantly reduces response time and token usage.

## How It Works

1. **Request**: The editor sends the current code to the AI along with your instructions
2. **AI Response**: The AI returns only the changes in unified diff format (like `git diff`)
3. **Application**: The editor automatically applies these changes to your code

## Diff Format Example

When you ask the AI to make a change, it responds with a diff like this:

```diff
@@ -5,3 +5,3 @@
 const canvas = document.getElementById("myCanvas")
 const ctx = canvas.getContext("2d")
-ctx.fillStyle = "blue"
+ctx.fillStyle = "red"
```

This means:
- Line 7: Remove `ctx.fillStyle = "blue"`
- Line 7: Add `ctx.fillStyle = "red"`

## Benefits

- ✅ **Faster**: AI only generates the changes, not the entire file
- ✅ **Cheaper**: Fewer tokens used in responses
- ✅ **Clearer**: You can see exactly what changed
- ✅ **Reliable**: Preserves unchanged code exactly as-is

## Fallback Support

If the AI doesn't provide a diff (or provides complete code), the editor will:
1. Try to extract code from markdown code blocks
2. Apply it as a complete replacement
3. Show a message indicating full file was received

This ensures backward compatibility with older AI models or responses.

## For Advanced Users

The unified diff format follows the standard POSIX format:
- `@@` lines indicate where changes occur (line numbers)
- Lines starting with `-` are removed
- Lines starting with `+` are added
- Lines starting with ` ` (space) are context (unchanged)

