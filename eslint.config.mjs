import globals from "globals"
import pluginJs from "@eslint/js"
import html from "eslint-plugin-html"
import {defineConfig} from "eslint/config"

export default defineConfig([
	pluginJs.configs.recommended,
	{
		languageOptions: {globals: globals.browser},
	},
	{
		files: ['**/*.html', '**/*.js', '**/*.mjs'],
		plugins: {
			html,
		},
		rules: {
			// "@stylistic/semi": ["error", "never"] ,
			"comma-dangle": ["warn", "always-multiline"],
			"consistent-return": "warn",
			"indent": ["warn", "tab", {"SwitchCase": 1}],
			"no-else-return": "warn",
			"no-tabs": 0,
			"no-var": "warn",
			"radix": "warn",
			"no-multiple-empty-lines": "warn",
			"brace-style": ["warn", "stroustrup", {"allowSingleLine": true}],
			"no-multi-spaces": ["warn", {"ignoreEOLComments": true}],
			"semi": ["warn", "never"],
			// "quotes": ["warn", "single", { "allowTemplateLiterals": true }], // disabled for kids
			"space-before-function-paren": ["warn", {
				"anonymous": "never",
				"named": "never",
				"asyncArrow": "always",
			}],
			"object-curly-spacing": ["warn", "never"],
			"space-before-blocks": ["warn", "always"],
			"arrow-parens": ["warn", "always"],
			"no-console": 0,
			// "no-unused-vars": ["error", {"args": "none"}],
			"no-unused-vars": ["off"], // disabled for HTML files
			"keyword-spacing": "warn",
		},
	},
])
