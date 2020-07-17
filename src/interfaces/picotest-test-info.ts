/**
 * PicoTest test metadata
 */
export interface PicotestTestInfo {
  name: string;
  file: string;
  line: number;
  subtests?: PicotestTestInfo[];
}
