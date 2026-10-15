export interface Script {
  req?: string | null;
  res?: string | null;
  beforeCallStart?: string | null;
  beforeMessageSend?: string | null;
  afterMessageReceive?: string | null;
  afterCallEnd?: string | null;
}
