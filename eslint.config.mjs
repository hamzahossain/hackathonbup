import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettier from "eslint-plugin-prettier";
import globals from "globals";

export default [
    {
        ignores: ["**/dist", "**/node_modules"],
        plugins: {
            "@typescript-eslint": typescriptEslint,
            prettier,
        },
        languageOptions: {
            parser: tsParser,
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "prettier/prettier": "error",
            "no-var": "error",
            "prefer-const": "error",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unused-vars": "warn",
        },
    },
];
