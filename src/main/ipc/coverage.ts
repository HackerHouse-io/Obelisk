import type { IpcMap } from '../../shared/types';
import { buildCoverageReport } from '../coverage/aggregate';

export async function handleCoverageList(
  payload: IpcMap['coverage:list']['req'],
): Promise<IpcMap['coverage:list']['res']> {
  return buildCoverageReport(payload.repoId);
}
