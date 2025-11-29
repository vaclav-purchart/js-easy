// keyboard.js
// ------------------------------------------------------------
// Virtual US Keyboard for Monaco Editor
// Exports:
//   openKeyboard(editor)
//   handleVirtualKeyPress(char)
// ------------------------------------------------------------

let keyboardContainer = null
let currentEditor = null
let isShift = false
let isCaps = false
let scale = 1.0

const ZOOM_FACTOR = 1.2

// Physical layout (US)
const LAYOUT = [
	// Row 1
	[
		{ key: '`' }, { key: '1' }, { key: '2' }, { key: '3' }, { key: '4' },
		{ key: '5' }, { key: '6' }, { key: '7' }, { key: '8' }, { key: '9' },
		{ key: '0' }, { key: '-' }, { key: '=' },
		{ key: 'Backspace', func: true, width: 90 },
	],
	// Row 2
	[
		{ key: 'Tab', func: true, width: 70 },
		{ key: 'q' }, { key: 'w' }, { key: 'e' }, { key: 'r' }, { key: 't' },
		{ key: 'y' }, { key: 'u' }, { key: 'i' }, { key: 'o' }, { key: 'p' },
		{ key: '[' }, { key: ']' }, { key: '\\' },
	],
	// Row 3
	[
		{ key: 'Caps', func: true, width: 100 },
		{ key: 'a' }, { key: 's' }, { key: 'd' }, { key: 'f' }, { key: 'g' },
		{ key: 'h' }, { key: 'j' }, { key: 'k' }, { key: 'l' },
		{ key: ';' }, { key: '\'' },
		{ key: 'Enter', func: true, width: 80 },
	],
	// Row 4
	[
		{ key: 'Shift', func: true, width: 130 },
		{ key: 'z' }, { key: 'x' }, { key: 'c' }, { key: 'v' }, { key: 'b' },
		{ key: 'n' }, { key: 'm' }, { key: ',' }, { key: '.' }, { key: '/' },
	],
	// Row 5
	[
		{ key: 'Space', func: true, width: 600 },
	],
]

// Shift symbols
const SHIFT_MAP = {
	'`': '~',
	'1': '!',
	'2': '@',
	'3': '#',
	'4': '$',
	'5': '%',
	'6': '^',
	'7': '&',
	'8': '*',
	'9': '(',
	'0': ')',
	'-': '_',
	'=': '+',
	'[': '{',
	']': '}',
	'\\': '|',
	';': ':',
	"'": '"',
	',': '<',
	'.': '>',
	'/': '?',
}

// ------------------------------------------------------------
// Insert character into Monaco editor
// ------------------------------------------------------------
export function handleVirtualKeyPress(char) {
	if (!currentEditor) return

	if (char === "\b") {
		currentEditor.trigger("keyboard", "deleteLeft")
		return
	}
	if (char === "\t") {
		currentEditor.trigger("keyboard", "type", { text: "\t" })
		return
	}
	if (char === "\n") {
		currentEditor.trigger("keyboard", "type", { text: "\n" })
		return
	}

	currentEditor.trigger("keyboard", "type", { text: char })
	currentEditor.focus()
}

// ------------------------------------------------------------
// Build a single key element
// ------------------------------------------------------------
function makeKey(info) {
	const btn = document.createElement("button")
	const base = info.key

	btn.className = "vk-key"
	btn.dataset.base = base
	btn.style.width = (info.width || 50) + "px"

	if (info.func) btn.classList.add("vk-func")

	btn.textContent = base

	btn.onclick = () => {
		let out = btn.textContent

		// Special keys
		if (base === "Shift") {
			isShift = !isShift
			updateKeyLabels()
			return
		}
		if (base === "Caps") {
			isCaps = !isCaps
			updateKeyLabels()
			return
		}
		if (base === "Backspace") {
			handleVirtualKeyPress("\b")
			return
		}
		if (base === "Enter") {
			handleVirtualKeyPress("\n")
			return
		}
		if (base === "Tab") {
			handleVirtualKeyPress("\t")
			return
		}
		if (base === "Space") {
			handleVirtualKeyPress(" ")
			return
		}

		// Normal key
		handleVirtualKeyPress(out)

		// Shift resets after one press
		if (isShift) {
			isShift = false
			updateKeyLabels()
		}
	}

	return btn
}

// ------------------------------------------------------------
// Update visible labels
// ------------------------------------------------------------
function updateKeyLabels() {
	const keys = keyboardContainer.querySelectorAll(".vk-key")

	keys.forEach((btn) => {
		const base = btn.dataset.base
		if (!base || base.length > 1) return // ignore func keys

		let output = base

		if (isCaps && /[a-z]/.test(base)) {
			output = base.toUpperCase()
		}
		if (isShift) {
			if (SHIFT_MAP[base]) {
				output = SHIFT_MAP[base]
			} else if (/[a-z]/.test(base)) {
				output = base.toUpperCase()
			}
		}

		btn.textContent = output
	})
}

// ------------------------------------------------------------
// Build full keyboard DOM
// ------------------------------------------------------------
function buildKeyboard() {
	keyboardContainer = document.createElement("div")
	keyboardContainer.id = "virtual-keyboard"

	keyboardContainer.innerHTML = `
        <style>
        #virtual-keyboard {
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 900px;
            background: #f1f1f1;
            border: 1px solid #aaa;
            padding: 10px;
            border-radius: 8px;
            box-shadow: 0px 4px 12px rgba(0,0,0,0.2);
            z-index: 99999;
			height: 325px;
        }
        #vk-header {
            background: #ccc;
            padding: 6px 10px;
            cursor: move;
            border-radius: 4px;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
        }
        #vk-close {
            cursor: pointer;
            padding: 2px 8px;
            background: #b33;
            color: white;
            border-radius: 4px;
        }
        #vk-close:hover {
            background: #d44;
        }
		#vk-zoom-in {
			box-sizing: border-box;
		}
		#vk-zoom-in:hover {
			border: 2px solid black;
			border-radius: 3px;
			cursor: pointer;
		}
		#vk-zoom-out {
			box-sizing: border-box;
		}
		#vk-zoom-out:hover {
			border: 2px solid black;
			border-radius: 3px;
			cursor: pointer;
		}
        .vk-row {
            display: flex;
            margin-top: 6px;
        }
        .vk-key {
            height: 42px;
            margin: 3px;
            border: 1px solid #888;
            border-radius: 4px;
            background: white;
            font-size: 16px;
            cursor: pointer;
        }
        .vk-key:hover {
            background: #e6e6e6;
        }
        .vk-func {
            background: #ddd;
            font-weight: bold;
        }
        </style>

        <div id="vk-header">
            🖮 Virtual Keyboard
			<span>
            <span id="vk-zoom-in">🔎+</span>
            <span id="vk-zoom-out">🔎-</span>
			</span>
            <span id="vk-close">✖</span>
        </div>
    `

	// Build rows
	LAYOUT.forEach((row) => {
		const rowDiv = document.createElement("div")
		rowDiv.className = "vk-row"

		row.forEach((keyInfo) => {
			const btn = makeKey(keyInfo)
			rowDiv.appendChild(btn)
		})

		keyboardContainer.appendChild(rowDiv)
	})

	document.body.appendChild(keyboardContainer)

	// Close button
	document.getElementById("vk-close").onclick = () => {
		keyboardContainer.style.display = "none"
	}

	// Zoom in button
	document.getElementById("vk-zoom-in").onclick = () => {
		scale *= ZOOM_FACTOR
		keyboardContainer.style.transform = `scale(${scale, scale})`
	}

	// Zoom out button
	document.getElementById("vk-zoom-out").onclick = () => {
		scale /= ZOOM_FACTOR
		keyboardContainer.style.transform = `scale(${scale, scale})`
	}

	// Make draggable
	enableDrag(keyboardContainer, document.getElementById("vk-header"))

	updateKeyLabels()
}

// ------------------------------------------------------------
// Make panel draggable
// ------------------------------------------------------------
function enableDrag(panel, handle) {
	let dragging = false, offsetX = 0, offsetY = 0

	handle.onmousedown = (e) => {
		dragging = true
		offsetX = e.clientX - panel.offsetLeft
		offsetY = e.clientY - panel.offsetTop
	}
	document.onmousemove = (e) => {
		if (!dragging) return
		panel.style.left = (e.clientX - offsetX) + "px"
		panel.style.top = (e.clientY - offsetY) + "px"
	}
	document.onmouseup = () => dragging = false
}

// ------------------------------------------------------------
// Public function: open keyboard
// ------------------------------------------------------------
export function openKeyboard(editor) {
	currentEditor = editor

	if (!keyboardContainer) buildKeyboard()

	keyboardContainer.style.display = "block"
}
