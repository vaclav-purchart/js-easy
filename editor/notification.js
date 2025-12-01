// notification.js
// ------------------------------------------------------------
// Modern Toast Notification System
// Exports:
//   showNotification(message, options)
// ------------------------------------------------------------

const DEFAULT_OPTIONS = {
	duration: 3000,
	position: 'top', // 'top' or 'bottom'
	type: 'info', // 'info', 'success', 'error', 'warning'
}

let container = null
let toastQueue = []

function initContainer(position) {
	if (!container) {
		container = document.createElement('div')
		container.id = 'toast-container'
		container.style.cssText = `
			position: fixed;
			left: 50%;
			transform: translateX(-50%);
			${position === 'bottom' ? 'bottom: 24px;' : 'top: 24px;'}
			z-index: 10000;
			display: flex;
			flex-direction: ${position === 'bottom' ? 'column-reverse' : 'column'};
			gap: 12px;
			pointer-events: none;
			max-width: 90vw;
			width: 400px;
		`
		document.body.appendChild(container)
	}

	// Update position if it changed
	if (position === 'bottom') {
		container.style.bottom = '24px'
		container.style.top = 'auto'
		container.style.flexDirection = 'column-reverse'
	} else {
		container.style.top = '24px'
		container.style.bottom = 'auto'
		container.style.flexDirection = 'column'
	}
}

function getTypeStyles(type) {
	const styles = {
		info: {
			background: 'linear-gradient(135deg, #dce4ff 0%, #e8d9ff 100%)',
			color: '#4c5fd5',
			icon: 'ℹ️',
		},
		success: {
			background: 'linear-gradient(135deg, #d4f4e7 0%, #d0f0e0 100%)',
			color: '#0a7d47',
			icon: '✓',
		},
		error: {
			background: 'linear-gradient(135deg, #ffe0e6 0%, #ffd9d9 100%)',
			color: '#c41e3a',
			icon: '✕',
		},
		warning: {
			background: 'linear-gradient(135deg, #fff0d9 0%, #ffe8d4 100%)',
			color: '#c86b00',
			icon: '⚠',
		},
	}
	return styles[type] || styles.info
}

/**
 * Display a toast notification
 * @param {string} message Message to display
 * @param {{
 * 	duration?: number,
 * 	position?: 'top' | 'bottom',
 * 	type?: 'info' | 'success' | 'error' | 'warning',
 * }} options Optional configuration
 * @returns
 */
export function showNotification(message, options = {}) {
	const config = { ...DEFAULT_OPTIONS, ...options }
	initContainer(config.position)

	const typeStyles = getTypeStyles(config.type)

	// Create toast element
	const toastEl = document.createElement('div')
	toastEl.style.cssText = `
		background: ${typeStyles.background};
		color: ${typeStyles.color};
		padding: 16px 20px;
		border-radius: 12px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08);
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		font-size: 15px;
		font-weight: 500;
		display: flex;
		align-items: center;
		gap: 12px;
		pointer-events: auto;
		cursor: pointer;
		backdrop-filter: blur(10px);
		transform: translateY(${config.position === 'bottom' ? '100%' : '-100%'}) scale(0.9);
		opacity: 0;
		transition: all 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
		max-width: 100%;
		word-wrap: break-word;
	`

	// Icon
	const iconEl = document.createElement('span')
	iconEl.style.cssText = `
		font-size: 18px;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
    	background: rgba(255, 255, 255, 0.5);
		border-radius: 50%;
	`
	iconEl.textContent = typeStyles.icon

	// Message
	const messageEl = document.createElement('span')
	messageEl.style.cssText = `
		flex: 1;
		line-height: 1.4;
	`
	messageEl.textContent = message

	toastEl.appendChild(iconEl)
	toastEl.appendChild(messageEl)

	// Add to container
	container.appendChild(toastEl)
	toastQueue.push(toastEl)

	// Trigger animation
	requestAnimationFrame(() => {
		toastEl.style.transform = 'translateY(0) scale(1)'
		toastEl.style.opacity = '1'
	})

	// Remove function
	const remove = () => {
		toastEl.style.transform = `translateY(${config.position === 'bottom' ? '100%' : '-100%'}) scale(0.9)`
		toastEl.style.opacity = '0'

		setTimeout(() => {
			if (toastEl.parentNode) {
				toastEl.parentNode.removeChild(toastEl)
			}
			toastQueue = toastQueue.filter((t) => t !== toastEl)

			// Remove container if empty
			if (toastQueue.length === 0 && container) {
				document.body.removeChild(container)
				container = null
			}
		}, 300)
	}

	// Click to dismiss
	toastEl.addEventListener('click', remove)

	// Auto dismiss
	if (config.duration > 0) {
		setTimeout(remove, config.duration)
	}

	return { remove }
}

// Convenience methods
showNotification.success = (message, options) => showNotification(message, { ...options, type: 'success' })
showNotification.error = (message, options) => showNotification(message, { ...options, type: 'error' })
showNotification.warning = (message, options) => showNotification(message, { ...options, type: 'warning' })
showNotification.info = (message, options) => showNotification(message, { ...options, type: 'info' })
