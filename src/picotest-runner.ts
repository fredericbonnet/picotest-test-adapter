/**
 * @file PicoTest test discovery & execution
 */

import * as child_process from 'child_process';
import * as fs from 'fs';

import { PicotestTestInfo } from './interfaces/picotest-test-info';
import { PicotestTestProcess } from './interfaces/picotest-test-process';
import { PicotestTestResult } from './interfaces/picotest-test-result';

const cj = require('concatjson');
const { split } = require('split-cmd');

/**
 * Load PicoTest test list
 *
 * @param command Test command/path
 * @param cwd Directory to run the test within
 * @param loadArgs Arguments passed to test command at load time
 */
export function loadPicotestTests(
  command: string,
  cwd: string,
  loadArgs: string
): Promise<PicotestTestInfo[]> {
  return new Promise<PicotestTestInfo[]>((resolve, reject) => {
    try {
      // Check that cwd directory exists
      // Note: statSync will throw an error if path doesn't exist
      if (!fs.statSync(cwd).isDirectory()) {
        throw new Error(`Directory '${cwd}' does not exist`);
      }

      // Split args string into array for spawn
      const args = split(loadArgs);

      // Execute the test command to get the test list in JSON format
      const testProcess = child_process.spawn(command, args, { cwd });
      if (!testProcess.pid) {
        // Something failed, e.g. the executable or cwd doesn't exist
        throw new Error(`Cannot spawn command '${command}'`);
      }

      // Capture test suite as concatenated JSON on stdout
      const tests: PicotestTestInfo[] = [];
      testProcess.stdout
        .pipe(cj.parse())
        .on('data', (data: any) => {
          tests.push(data as PicotestTestInfo);
        })
        .on('end', () => {
          resolve(tests);
        })
        .on('error', (error: Error) => reject(error));
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Schedule a PicoTest test process
 *
 * @param command Test command/path
 * @param cwd Directory to run the test within
 * @param tests Tests to run (empty for all)
 * @param runArgs Arguments passed to test command at run time
 */
export function schedulePicotestTestProcess(
  command: string,
  cwd: string,
  tests: string[],
  runArgs: string
): PicotestTestProcess {
  // Split args string into array for spawn
  const args = split(runArgs);

  const testProcess = child_process.spawn(command, [...args, ...tests], {
    cwd,
  });
  if (!testProcess.pid) {
    // Something failed, e.g. the executable or cwd doesn't exist
    throw new Error(`Cannot run tests ${JSON.stringify(tests)}`);
  }

  return testProcess;
}

/**
 * Execute a previously scheduled PicoTest test process
 *
 * @param testProcess Scheduled test process
 * @param onEvent Event callback
 */
export function executePicotestTestProcess(
  testProcess: PicotestTestProcess,
  onEvent: (event: PicotestEvent) => void
): Promise<PicotestTestResult> {
  return new Promise<PicotestTestResult>((resolve, reject) => {
    try {
      // Capture result on stdout
      testProcess.stdout
        .pipe(cj.parse())
        .on('data', (data: any) => onEvent(data as PicotestEvent));

      // The 'exit' event is always sent even if the child process crashes or is
      // killed so we can safely resolve/reject the promise from there
      testProcess.once('exit', (code) => {
        const result: PicotestTestResult = {
          code,
        };
        resolve(result);
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Cancel a previously scheduled PicoTest test process
 *
 * @param testProcess Scheduled test process
 */
export function cancelPicotestTestProcess(testProcess: PicotestTestProcess) {
  testProcess.kill();
}

/** Generic test event */
export type PicotestEvent =
  | PicotestFailureEvent
  | PicotestSuiteEnterEvent
  | PicotestSuiteLeaveEvent
  | PicotestCaseEnterEvent
  | PicotestCaseLeaveEvent;

/** Failure event */
export interface PicotestFailureEvent {
  hook: 'FAILURE';
  file: string;
  line: number;
  type: string;
  test: string;
  msg?: string;
}

/** Test suite enter event */
export interface PicotestSuiteEnterEvent {
  hook: 'SUITE_ENTER';
  suiteName: string;
  nb: number;
}

/** Test suite leave event */
export interface PicotestSuiteLeaveEvent {
  hook: 'SUITE_LEAVE';
  suiteName: string;
  nb: number;
  fail: number;
}

/** Test case enter event */
export interface PicotestCaseEnterEvent {
  hook: 'CASE_ENTER';
  testName: string;
}

/** Test case leave event */
export interface PicotestCaseLeaveEvent {
  hook: 'CASE_LEAVE';
  testName: string;
  fail: number;
}
