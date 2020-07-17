import * as vscode from 'vscode';
import * as path from 'path';
import {
  TestAdapter,
  TestLoadStartedEvent,
  TestLoadFinishedEvent,
  TestRunStartedEvent,
  TestRunFinishedEvent,
  TestSuiteEvent,
  TestEvent,
  TestSuiteInfo,
  TestInfo,
} from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';
import { PicotestTestInfo } from './interfaces/picotest-test-info';
import { loadPicotestTests } from './picotest-runner';

/** Special ID value for the root suite */
const ROOT_SUITE_ID = '*';

/**
 * This class is intended as a starting point for implementing a "real" TestAdapter.
 * The file `README.md` contains further instructions.
 */
export class PicotestAdapter implements TestAdapter {
  private disposables: { dispose(): void }[] = [];

  /** Discovered Picotest tests */
  private picotestTests: PicotestTestInfo[] = [];

  /** State */
  private state: 'idle' | 'loading' | 'running' | 'cancelled' = 'idle';

  /** Currently running test */
  //TODO private currentTestProcess?: PicotestTestProcess;

  //
  // TestAdapter implementations
  //

  private readonly testsEmitter = new vscode.EventEmitter<
    TestLoadStartedEvent | TestLoadFinishedEvent
  >();
  private readonly testStatesEmitter = new vscode.EventEmitter<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  >();
  private readonly autorunEmitter = new vscode.EventEmitter<void>();

  get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
    return this.testsEmitter.event;
  }
  get testStates(): vscode.Event<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  > {
    return this.testStatesEmitter.event;
  }
  get autorun(): vscode.Event<void> | undefined {
    return this.autorunEmitter.event;
  }

  constructor(
    public readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly log: Log
  ) {
    this.log.info('Initializing PicoTest adapter');

    this.disposables.push(this.testsEmitter);
    this.disposables.push(this.testStatesEmitter);
    this.disposables.push(this.autorunEmitter);
  }

  async load(): Promise<void> {
    if (this.state !== 'idle') return; // it is safe to ignore a call to `load()`, even if it comes directly from the Test Explorer

    this.state = 'loading';
    this.log.info('Loading PicoTest tests');
    this.testsEmitter.fire(<TestLoadStartedEvent>{ type: 'started' });

    try {
      const suite = await this.loadTestSuite();
      this.testsEmitter.fire(<TestLoadFinishedEvent>{
        type: 'finished',
        suite,
      });
    } catch (e) {
      this.testsEmitter.fire(<TestLoadFinishedEvent>{
        type: 'finished',
        errorMessage: e.toString(),
      });
    }

    this.state = 'idle';
  }

  async run(tests: string[]): Promise<void> {
    if (this.state !== 'idle') return; // it is safe to ignore a call to `run()`

    this.state = 'running';
    this.log.info(`Running PicoTest tests ${JSON.stringify(tests)}`);
    this.testStatesEmitter.fire(<TestRunStartedEvent>{
      type: 'started',
      tests,
    });

    try {
      for (const id of tests) {
        await this.runTest(id);
      }
    } catch (e) {
      // Fail silently
    }

    this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
    this.state = 'idle';
  }

  /*TODO
  async debug(tests: string[]): Promise<void> {
    this.log.info(`Debugging PicoTest tests ${JSON.stringify(tests)}`);

    try {
      for (const id of tests) {
        await this.debugTest(id);
      }
    } catch (e) {
      // Fail silently
    }
  }
  */

  cancel(): void {
    if (this.state !== 'running') return; // ignore

    // TODO if (this.currentTestProcess) cancelPicotestTest(this.currentTestProcess);

    // State will eventually transition to idle once the run loop completes
    this.state = 'cancelled';
  }

  dispose(): void {
    this.cancel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  /**
   * Load test suite
   */
  private async loadTestSuite(): Promise<TestSuiteInfo> {
    // Get & substitute config settings
    const [testCommand, testCwd, loadArgs] = await this.getConfigStrings([
      'testCommand',
      'testCwd',
      'loadArgs',
    ]);

    // Load test list
    const cwd = path.resolve(this.workspaceFolder.uri.fsPath, testCwd);
    this.picotestTests = await loadPicotestTests(testCommand, cwd, loadArgs);

    // Convert to Text Explorer format
    const suite: TestSuiteInfo = {
      type: 'suite',
      id: ROOT_SUITE_ID,
      label: 'PicoTest', // the label of the root node should be the name of the testing framework
      children: this.picotestTests.map(convertPicotestInfo),
    };
    return suite;
  }

  /**
   * Run tests
   *
   * @param id Test or suite ID
   */
  private async runTest(id: string) {
    // TODO
  }

  /**
   * Debug a single test
   *
   * @param id Test ID
   */
  /*TODO
  private async debugTest(id: string) {
  }
  */

  /**
   * Get workspace configuration object
   */
  private getWorkspaceConfiguration() {
    return vscode.workspace.getConfiguration(
      'picotestExplorer',
      this.workspaceFolder.uri
    );
  }

  /**
   * Get & substitute config settings
   *
   * @param name Config names
   *
   * @return Config values
   */
  private async getConfigStrings(names: string[]) {
    const config = this.getWorkspaceConfiguration();
    const varMap = await this.getVariableSubstitutionMap();
    return names.map((name) => this.configGetStr(config, varMap, name));
  }

  /**
   * Get & substitute config settings
   *
   * @param config VS Code workspace configuration
   * @param varMap Variable to value map
   * @param key Config name
   */
  private configGetStr(
    config: vscode.WorkspaceConfiguration,
    varMap: Map<string, string>,
    key: string
  ) {
    const configStr = config.get<string>(key) || '';
    let str = configStr;
    varMap.forEach((value, key) => {
      while (str.indexOf(key) > -1) {
        str = str.replace(key, value);
      }
    });
    return str;
  }

  /**
   * Get variable to value substitution map for config strings
   */
  private async getVariableSubstitutionMap() {
    // Standard variables
    const substitutionMap = new Map<string, string>([
      ['${workspaceFolder}', this.workspaceFolder.uri.fsPath],
    ]);

    return substitutionMap;
  }
}

/**
 * Convert PicoTest test to Text Explorer format
 *
 * @param test PicoTest test to convert
 */
function convertPicotestInfo(test: PicotestTestInfo): TestSuiteInfo | TestInfo {
  if (test.subtests) {
    return {
      type: 'suite',
      id: test.name,
      label: test.name,
      file: test.file,
      line: test.line,
      children: test.subtests.map(convertPicotestInfo),
    };
  } else {
    return {
      type: 'test',
      id: test.name,
      label: test.name,
      file: test.file,
      line: test.line,
    };
  }
}
