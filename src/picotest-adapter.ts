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
  RetireEvent,
} from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';
import { PicotestTestInfo } from './interfaces/picotest-test-info';
import { PicotestTestProcess } from './interfaces/picotest-test-process';
import {
  loadPicotestTests,
  schedulePicotestTestProcess,
  executePicotestTestProcess,
  cancelPicotestTestProcess,
  PicotestEvent,
  PicotestFailureEvent,
} from './picotest-runner';

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
  private currentTestProcess?: PicotestTestProcess;

  //
  // TestAdapter implementations
  //

  private readonly testsEmitter = new vscode.EventEmitter<
    TestLoadStartedEvent | TestLoadFinishedEvent
  >();
  private readonly testStatesEmitter = new vscode.EventEmitter<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  >();
  private readonly retireEmitter = new vscode.EventEmitter<RetireEvent>();
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

    const runAll = tests.length == 1 && tests[0] === ROOT_SUITE_ID;
    if (runAll) {
      try {
        this.testStatesEmitter.fire(<TestSuiteEvent>{
          type: 'suite',
          suite: ROOT_SUITE_ID,
          state: 'running',
        });
        await this.runTests([]);
        this.testStatesEmitter.fire(<TestSuiteEvent>{
          type: 'suite',
          suite: ROOT_SUITE_ID,
          state: 'completed',
        });
      } catch (e) {
        this.testStatesEmitter.fire(<TestSuiteEvent>{
          type: 'suite',
          suite: ROOT_SUITE_ID,
          state: 'errored',
          message: e.toString(),
        });
      }
    } else {
      try {
        await this.runTests(tests);
      } catch (e) {
        // Fail silently
      }
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

    if (this.currentTestProcess)
      cancelPicotestTestProcess(this.currentTestProcess);

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
   * @param tests Test IDs (empty for all)
   */
  private async runTests(tests: string[]) {
    if (this.state === 'cancelled') {
      // Test run cancelled, retire test
      this.retireEmitter.fire(<RetireEvent>{ tests });
      return;
    }

    try {
      // Get & substitute config settings
      const [testCommand, testCwd, runArgs] = await this.getConfigStrings([
        'testCommand',
        'testCwd',
        'runArgs',
      ]);

      // Run tests
      const cwd = path.resolve(this.workspaceFolder.uri.fsPath, testCwd);

      this.currentTestProcess = schedulePicotestTestProcess(
        testCommand,
        cwd,
        tests,
        runArgs
      );
      let failures: PicotestFailureEvent[] = [];
      await executePicotestTestProcess(
        this.currentTestProcess,
        (event: PicotestEvent) => {
          switch (event.hook) {
            case 'FAILURE':
              failures.push(event);
              break;
            case 'SUITE_ENTER':
              this.testStatesEmitter.fire(<TestSuiteEvent>{
                type: 'suite',
                suite: event.suiteName,
                state: 'running',
              });
              break;
            case 'SUITE_LEAVE':
              this.testStatesEmitter.fire(<TestSuiteEvent>{
                type: 'suite',
                suite: event.suiteName,
                state: 'completed',
              });
              break;
            case 'CASE_ENTER':
              this.testStatesEmitter.fire(<TestEvent>{
                type: 'test',
                test: event.testName,
                state: 'running',
              });
              failures = [];
              break;
            case 'CASE_LEAVE':
              this.testStatesEmitter.fire(<TestEvent>{
                type: 'test',
                test: event.testName,
                state: event.fail ? 'failed' : 'passed',
                decorations: failures.map(toDecoration),
                message: failures.map(toMessage).join('\n'),
              });
              break;
          }
        }
      );
    } finally {
      this.currentTestProcess = undefined;
    }
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
      line: test.line - 1,
      children: test.subtests.map(convertPicotestInfo),
    };
  } else {
    return {
      type: 'test',
      id: test.name,
      label: test.name,
      file: test.file,
      line: test.line - 1,
    };
  }
}

/**
 * Format PicoTest error message from failure event
 *
 * @param event PicoTest failure event
 */
function getErrorMessage(event: PicotestFailureEvent) {
  return event.msg
    ? `[${event.type}] ${event.test} | ${event.msg}`
    : `[${event.type}] ${event.test}`;
}

/**
 * Convert Picotest failure event to Test Explorer decoration
 *
 * @param event PicoTest failure event
 */
function toDecoration(event: PicotestFailureEvent) {
  return {
    line: event.line - 1,
    file: event.file,
    message: getErrorMessage(event),
  };
}

/**
 * Convert Picotest failure event to error message
 *
 * @param event PicoTest failure event
 */
function toMessage(event: PicotestFailureEvent) {
  return `${event.file}:${event.line} - ${getErrorMessage(event)}`;
}
