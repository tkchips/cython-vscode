import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import Parser = require('tree-sitter');

const DEFAULT_TREE_SITTER_CYTHON_ROOT = '/home/tkc/workspace/tree-sitter-cython';
const QUERY_RELATIVE_PATH = path.join('queries', 'highlights.scm');
const REFRESH_PARSE_COMMAND = 'cython-vscode.refreshParse';
const SHOW_LOG_COMMAND = 'cython-vscode.showLog';
const OUTPUT_CHANNEL_NAME = 'cython-vscode';

const TOKEN_TYPES = [
	'class',
	'comment',
	'function',
	'keyword',
	'method',
	'number',
	'operator',
	'property',
	'string',
	'type',
	'variable',
] as const;

const TOKEN_MODIFIERS = ['defaultLibrary', 'readonly'] as const;

const LEGEND = new vscode.SemanticTokensLegend([...TOKEN_TYPES], [...TOKEN_MODIFIERS]);

type TokenType = typeof TOKEN_TYPES[number];
type TokenModifier = typeof TOKEN_MODIFIERS[number];

type TokenSpec = {
	type: TokenType;
	modifiers?: readonly TokenModifier[];
	priority: number;
};

type TokenSegment = {
	line: number;
	start: number;
	end: number;
	spec: TokenSpec;
};

type Runtime = {
	root: string;
	parser: Parser;
	query: Parser.Query;
};

type Logger = {
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
};

const CAPTURE_TOKEN_MAP = new Map<string, TokenSpec>([
	['comment', { type: 'comment', priority: 120 }],
	['string', { type: 'string', priority: 110 }],
	['number', { type: 'number', priority: 110 }],
	['keyword', { type: 'keyword', priority: 110 }],
	['operator', { type: 'operator', priority: 105 }],
	['function.builtin', { type: 'function', modifiers: ['defaultLibrary'], priority: 100 }],
	['function.method', { type: 'method', priority: 95 }],
	['function', { type: 'function', priority: 90 }],
	['constructor', { type: 'class', priority: 90 }],
	['type', { type: 'type', priority: 90 }],
	['property', { type: 'property', priority: 80 }],
	['constant.builtin', { type: 'variable', modifiers: ['defaultLibrary', 'readonly'], priority: 80 }],
	['constant', { type: 'variable', modifiers: ['readonly'], priority: 75 }],
	['variable', { type: 'variable', priority: 70 }],
	['escape', { type: 'string', priority: 115 }],
	['punctuation.special', { type: 'operator', priority: 100 }],
	['embedded', { type: 'string', priority: 100 }],
]);

class CythonSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider, vscode.Disposable {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChangeSemanticTokens = this.onDidChangeEmitter.event;
	private runtime: Runtime | undefined;
	private runtimeLoadError: string | undefined;
	private runtimeErrorShown = false;

	public constructor(private readonly logger: Logger) {}

	public provideDocumentSemanticTokens(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.SemanticTokens> {
		const runtime = this.getOrCreateRuntime();
		if (!runtime) {
			this.logger.warn(`Skip semantic tokens for ${document.uri.fsPath}: runtime unavailable`);
			return new vscode.SemanticTokensBuilder(LEGEND).build();
		}

		const tree = runtime.parser.parse(document.getText());
		const captures = runtime.query.captures(tree.rootNode);
		const segmentByRange = new Map<string, TokenSegment>();

		for (const capture of captures) {
			if (token.isCancellationRequested) {
				this.logger.info(`Semantic token request cancelled: ${document.uri.fsPath}`);
				return new vscode.SemanticTokensBuilder(LEGEND).build();
			}

			const spec = resolveTokenSpec(capture.name);
			if (!spec) {
				continue;
			}

			for (const segment of buildTokenSegments(document, capture.node, spec)) {
				const key = `${segment.line}:${segment.start}:${segment.end}`;
				const existing = segmentByRange.get(key);
				if (!existing || segment.spec.priority > existing.spec.priority) {
					segmentByRange.set(key, segment);
				}
			}
		}

		const segments = [...segmentByRange.values()].sort(compareSegments);
		const builder = new vscode.SemanticTokensBuilder(LEGEND);

		for (const segment of segments) {
			const modifiers = segment.spec.modifiers ?? [];
			builder.push(
				new vscode.Range(segment.line, segment.start, segment.line, segment.end),
				segment.spec.type,
				modifiers,
			);
		}

		this.logger.info(
			`Semantic tokens ready: ${document.uri.fsPath} (captures=${captures.length}, tokens=${segments.length})`,
		);
		return builder.build();
	}

	public refresh(reason: string): void {
		this.logger.info(`Manual parse refresh requested (${reason})`);
		this.runtime = undefined;
		this.runtimeLoadError = undefined;
		this.runtimeErrorShown = false;
		this.onDidChangeEmitter.fire();
	}

	public dispose(): void {
		this.onDidChangeEmitter.dispose();
	}

	private getOrCreateRuntime(): Runtime | undefined {
		const configuredRoot = getConfiguredTreeSitterRoot();
		if (this.runtime && this.runtime.root === configuredRoot) {
			return this.runtime;
		}

		this.runtime = undefined;
		this.runtimeLoadError = undefined;
		this.runtimeErrorShown = false;

		try {
			const queryPath = path.join(configuredRoot, QUERY_RELATIVE_PATH);
			const querySource = fs.readFileSync(queryPath, 'utf8');
			const language = loadTreeSitterLanguage(configuredRoot);
			const parser = new Parser();
			parser.setLanguage(language);

			this.runtime = {
				root: configuredRoot,
				parser,
				query: new Parser.Query(language, querySource),
			};
			this.logger.info(`Loaded tree-sitter-cython runtime from ${configuredRoot}`);
			return this.runtime;
		} catch (error) {
			this.runtimeLoadError = error instanceof Error ? error.message : String(error);
			this.logger.error(
				`Failed to load tree-sitter-cython from ${configuredRoot}: ${this.runtimeLoadError}`,
			);
			if (!this.runtimeErrorShown) {
				this.runtimeErrorShown = true;
				void vscode.window.showWarningMessage(
					`cython-vscode: failed to load tree-sitter-cython from ${configuredRoot}. ${this.runtimeLoadError}`,
				);
			}
			return undefined;
		}
	}
}

function createLogger(channel: vscode.OutputChannel): Logger {
	const write = (level: 'INFO' | 'WARN' | 'ERROR', message: string): void => {
		channel.appendLine(`[${new Date().toISOString()}] [${level}] ${message}`);
	};
	return {
		info: (message: string) => write('INFO', message),
		warn: (message: string) => write('WARN', message),
		error: (message: string) => write('ERROR', message),
	};
}

function getConfiguredTreeSitterRoot(): string {
	const configured = vscode.workspace
		.getConfiguration('cython-vscode')
		.get<string>('treeSitterCythonRoot', DEFAULT_TREE_SITTER_CYTHON_ROOT)
		.trim();
	return configured.length > 0 ? configured : DEFAULT_TREE_SITTER_CYTHON_ROOT;
}

function loadTreeSitterLanguage(root: string): Parser.Language {
	const languageModule = require(root) as unknown;
	return languageModule as Parser.Language;
}

function resolveTokenSpec(captureName: string): TokenSpec | undefined {
	const direct = CAPTURE_TOKEN_MAP.get(captureName);
	if (direct) {
		return direct;
	}

	const [prefix] = captureName.split('.', 1);
	if (!prefix) {
		return undefined;
	}
	return CAPTURE_TOKEN_MAP.get(prefix);
}

function buildTokenSegments(document: vscode.TextDocument, node: Parser.SyntaxNode, spec: TokenSpec): TokenSegment[] {
	const start = node.startPosition;
	const end = node.endPosition;

	if (start.row > end.row || (start.row === end.row && start.column >= end.column)) {
		return [];
	}

	if (start.row === end.row) {
		return [{ line: start.row, start: start.column, end: end.column, spec }];
	}

	const segments: TokenSegment[] = [];
	const firstLineEnd = document.lineAt(start.row).text.length;
	if (start.column < firstLineEnd) {
		segments.push({ line: start.row, start: start.column, end: firstLineEnd, spec });
	}

	for (let line = start.row + 1; line < end.row; line += 1) {
		const lineLength = document.lineAt(line).text.length;
		if (lineLength > 0) {
			segments.push({ line, start: 0, end: lineLength, spec });
		}
	}

	if (end.column > 0) {
		segments.push({ line: end.row, start: 0, end: end.column, spec });
	}

	return segments;
}

function compareSegments(a: TokenSegment, b: TokenSegment): number {
	if (a.line !== b.line) {
		return a.line - b.line;
	}
	if (a.start !== b.start) {
		return a.start - b.start;
	}
	return a.end - b.end;
}

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	const logger = createLogger(outputChannel);
	context.subscriptions.push(outputChannel);

	const selector: vscode.DocumentSelector = [{ language: 'cython' }];
	const provider = new CythonSemanticTokensProvider(logger);
	context.subscriptions.push(provider);
	context.subscriptions.push(
		vscode.languages.registerDocumentSemanticTokensProvider(selector, provider, LEGEND),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(REFRESH_PARSE_COMMAND, () => {
			const active = vscode.window.activeTextEditor;
			if (!active || active.document.languageId !== 'cython') {
				logger.warn('Refresh command ignored: no active Cython editor');
				void vscode.window.showInformationMessage('No active Cython editor to refresh.');
				return;
			}
			provider.refresh('context-menu');
			void vscode.window.setStatusBarMessage('Cython parse refreshed', 2500);
		}),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(SHOW_LOG_COMMAND, () => {
			outputChannel.show(true);
			logger.info('Output channel opened by command');
		}),
	);

	logger.info('Extension activated');
}

export function deactivate(): void {}
