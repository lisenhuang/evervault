// The Simplified Chinese deck.
//
// A reading aid, not a second product. The talk is delivered in English; this exists so the
// presenter can check, line by line, that he means what the English says. Which is why Deck.tsx
// always opens in English and never persists a language choice: the deck you open is the deck the
// audience sees, and Chinese is something you switch INTO deliberately and lose on refresh.
//
// STRUCTURE IS SHARED, PROSE IS NOT. Every entry mirrors its English counterpart: same `id`, same
// position, same components, same props. The ids are what let the language switch keep you on the
// slide you were looking at, and the shared structure is what lets one layout verification cover
// both languages. If you add a slide to slides.tsx, add it here in the same place — the two arrays
// are asserted to be the same length and order at module load (see the check at the foot of this
// file), so a mismatch fails loudly rather than silently truncating a deck.
//
// Technical terms keep their conventional Chinese-plus-English form (向量数据库, 工具调用, RRF,
// HNSW) because that is how the audience for this material actually reads and says them.

import { Sparkles, BrainCircuit, Wrench, Mic, Server, Shield, Rocket, Coins } from "lucide-react";
import {
  Slide,
  Cols,
  Eyebrow,
  H1,
  H2,
  Grad,
  Lead,
  Body,
  Mono,
  Bullets,
  Numbered,
  Card,
  Stat,
  Quote,
  Note,
  Chips,
  Rows,
  Ext,
} from "./ui";
import {
  TextInTextOut,
  RagPaths,
  EmbeddingSpace,
  DimensionMismatch,
  ThreeLanes,
  LiveModelIO,
  VoicePipelines,
  ToolLoop,
  Architecture,
} from "./diagrams";
import { SLIDES, type SlideDef } from "./slides";

export const SLIDES_ZH: SlideDef[] = [
  /* ------------------------------------------------------------------ 1 */
  {
    id: "title",
    title: "封面",
    node: (
      <Slide center>
        <Eyebrow icon={Sparkles}>evervault.life</Eyebrow>
        <div className="mt-[26px]">
          <H1>
            记住一切。
            <br />
            <Grad>什么都不用带。</Grad>
          </H1>
        </div>
        <div className="mt-[26px] max-w-[820px]">
          <Lead>
            做一个属于自己的记忆型 AI。以及，要给一个「文本进、文本出」的模型装上过去、数据库和互联网，到底需要什么。
          </Lead>
        </div>
        <div className="mt-[44px] flex flex-wrap items-center justify-center gap-x-[14px] gap-y-[6px] text-[length:var(--dk-lead)] text-black/45 dark:text-white/45">
          <span className="font-medium text-black/70 dark:text-white/70">Ethan Huang</span>
          <span aria-hidden="true">·</span>
          <span>奥克兰</span>
          <span aria-hidden="true">·</span>
          <span>2026</span>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 2 */
  {
    id: "why-memory",
    title: "动机 · 记忆",
    node: (
      <Slide>
        <Eyebrow tone="plain">我为什么做这个 · 其一</Eyebrow>
        <div className="mt-[22px] max-w-[980px]">
          <H2>你一关标签页，所有 AI 就把你忘干净了。</H2>
        </div>
        <div className="mt-[34px]">
          <Cols ratio="1.05fr 0.95fr" gap={56} align="start">
            <Bullets
              items={[
                "你把自己的背景讲一遍，再讲一遍。什么都攒不下来。",
                "上下文窗口不是记忆。它是一块白板，散会时有人把它擦干净。",
                "而你生命里真正值得留下的部分，恰恰是那些你只顺口提过一次、再也想不起来重复的事。",
              ]}
            />
            <Card>
              <Quote>
                记忆不该是别人产品里的一个功能。它该是你自己的东西：跑在你的机器上，存在你的 Postgres 里，用你自己的密钥。
              </Quote>
            </Card>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 3 */
  {
    id: "why-interaction",
    title: "动机 · 交互",
    node: (
      <Slide>
        <Eyebrow tone="plain">我为什么做这个 · 其二</Eyebrow>
        <div className="mt-[22px] max-w-[980px]">
          <H2>而且，交互总是差那么一点。</H2>
        </div>
        <div className="mt-[30px]">
          <Cols ratio="1.05fr 0.95fr" gap={56} align="start">
            <div className="space-y-[22px]">
              <Bullets
                items={[
                  "语音通话抢我的话。回复停不下来。在 iPhone 上，声音干脆放不出来。",
                  "我想针对某一条消息回复，就聊那一条。这个功能每个聊天软件十年前就有了，几乎没有一个 AI 助手有。",
                  "这些都不是难题。但从外面，一个都修不了。",
                  "你把反馈丢进一个黑洞，然后等一份不属于你的路线图。",
                ]}
              />
              <Note>所以我做了一个我有权改的。</Note>
            </div>
            <div className="space-y-[22px]">
              <Card>
                <Quote>
                  拥有代码，就是把「要是它能这样就好了」变成一次提交。周一提的反馈，周一就能上线。
                </Quote>
              </Card>
              <div className="flex flex-wrap gap-x-[44px] gap-y-[16px]">
                <Stat value="227" label="次提交" />
                <Stat value="52" label="天" />
                <Stat value="1" label="个人" />
              </div>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 4 */
  {
    id: "what",
    title: "它是什么",
    node: (
      <Slide>
        <Eyebrow icon={Sparkles}>EverVault</Eyebrow>
        <div className="mt-[22px] max-w-[900px]">
          <H2>
            一个跑在<Grad>你自己硬件上</Grad>的记忆型 AI。
          </H2>
        </div>
        <div className="mt-[32px]">
          <Cols ratio="1fr 1fr" gap={56} align="start">
            <div className="space-y-[20px]">
              <Body>
                文字、语音消息、实时通话，背后是同一份记忆。照片和文档永久可检索。一句{" "}
                <Mono>make up</Mono> 它就是你的了：你的密钥，你的数据库，你的磁盘。
              </Body>
              <Chips items={["AGPL-3.0", "自托管", "不需要任何厂商账号"]} />
            </div>
            <Rows
              rows={[
                ["前端", "Next.js 16 · App Router · Tailwind v4"],
                ["后端", ".NET 10 LTS · EF Core"],
                ["数据库", "Postgres 18 · pgvector"],
                ["移动端", "Expo SDK 56 · React Native"],
              ]}
            />
          </Cols>
        </div>
        <div className="mt-[38px] flex flex-wrap gap-x-[56px] gap-y-[18px]">
          <Stat value="7.3 万" label="行代码，前端加后端" />
          <Stat value="34" label="个数据库迁移" />
          <Stat value="12" label="个模型可调用的工具" />
          <Stat value="4" label="种界面语言" />
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 5 */
  {
    id: "pure-function",
    title: "大模型是纯函数",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          几个概念
        </Eyebrow>
        <div className="mt-[20px] max-w-[900px]">
          <H2>大模型只是一个函数：文本进，文本出。</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="0.92fr 1.08fr" gap={48}>
            <Bullets
              items={[
                "无状态。调用两次，第二次完全不知道第一次发生过什么。",
                "没有记忆，没有文件系统，没有网络，没有数据库。它够不着任何东西。",
                "你用过的每一个 AI 产品，都是围绕这一个函数搭出来的脚手架。",
              ]}
            />
            <TextInTextOut />
          </Cols>
        </div>
        <div className="mt-[30px]">
          <Note>
            接下来这场分享回答两个问题：怎么给它一个过去，以及怎么给它一双手。
          </Note>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 6 */
  {
    id: "rag",
    title: "RAG",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          一个过去 · RAG
        </Eyebrow>
        <div className="mt-[18px] max-w-[900px]">
          <H2>先检索，再生成。</H2>
        </div>
        <div className="mt-[26px]">
          <RagPaths />
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <Bullets
              items={[
                "最朴素的做法是把全部历史塞进每一次提示词。它会从四个方向死掉：token 成本、延迟、上下文上限，以及注意力被稀释。",
                "一万行历史，只会让模型更难找到真正相关的那一行。",
              ]}
            />
            <Quote>
              模型从来不会记住。记住的是数据库，而我们在每一轮对话的开头，重新讲给它听。
            </Quote>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 7 */
  {
    id: "embeddings",
    title: "向量化",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          一个过去 · 向量
        </Eyebrow>
        <div className="mt-[18px] max-w-[900px]">
          <H2>向量化，就是把文本变成坐标。</H2>
        </div>
        <div className="mt-[24px]">
          <Cols ratio="1.02fr 0.98fr" gap={48}>
            <div className="space-y-[18px]">
              <Bullets
                items={[
                  "嵌入模型把一段文本映射成一串定长的浮点数。典型的模型是 1536 个，你的管理页可以在 768、1536、3072 之间选一次。那就是这么多维空间里的一个点。",
                  "它被训练成：决定落点的是语义，不是字面。",
                  "「我当时在计划的那趟海边旅行」和「订了那间小屋，总算定下来了，挺好」没有一个共同的词。关键词检索什么都搜不到，最近邻检索把它排在第一。",
                  "相似度就是两个向量夹角的余弦。夹角越小，语义越近。",
                ]}
              />
            </div>
            <EmbeddingSpace />
          </Cols>
        </div>
        <div className="mt-[24px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <Note>
              所谓向量数据库，就是那个让「从一百万条里找出最近的 50 条」变成次线性、而不是全表扫描的索引。pgvector 的 HNSW 建的是一张可导航的小世界图：近似，但快到可以和其它数据待在同一个 Postgres 里。不需要第二个存储。
            </Note>
            <Note>
              以 <Mono>halfvec</Mono>（fp16）存储：磁盘占用只有全精度向量的一半，召回率的损失可以忽略。
            </Note>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 8 */
  {
    id: "locked-dims",
    title: "模型与维度锁死",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          一个过去 · 那条硬约束
        </Eyebrow>
        <div className="mt-[14px] max-w-[1000px]">
          <H2>为什么嵌入模型和它的维度永远不能改。</H2>
        </div>
        <div className="mt-[20px]">
          <Cols ratio="0.98fr 1.02fr" gap={44} align="start">
            <DimensionMismatch />
            <div className="space-y-[14px]">
              <Bullets
                items={[
                  "一个向量只在生成它的那个空间里有意义。第 400 维代表什么，是 A 模型说了算；B 模型的第 400 维，代表的是完全不同的东西。",
                  "跨着两个空间去比，余弦照样给你一个数。它只是不再是相似度而已。安静、看起来合理的垃圾，最糟糕的一种故障。",
                  "所以查询必须由同一个模型、在同一个宽度下向量化，和已经存进去的一切保持一致。写入和检索是同一个决定的两半。",
                ]}
              />
              <Card title="代码里怎么保证">
                嵌入配置在第一次使用时就被锁定（<Mono>LockedAt</Mono>），之后 API 会拒绝任何长度不等于锁定维度的向量。换模型意味着把每一行重新向量化：那是一次迁移，不是一个设置项。
              </Card>
              <Note>
                一个容易忽略的细节：同一个模型，但提示不对称。入库文本按 <Mono>RETRIEVAL_DOCUMENT</Mono>{" "}
                进，查询按 <Mono>RETRIEVAL_QUERY</Mono>。一个问题和它要找的那个答案，本来就不是同一类文本。
              </Note>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ------------------------------------------------------------------ 9 */
  {
    id: "hybrid",
    title: "混合检索 + RRF",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          一个过去 · 检索
        </Eyebrow>
        <div className="mt-[18px] max-w-[900px]">
          <H2>只有一种检索，永远不够。</H2>
        </div>
        <div className="mt-[24px]">
          <ThreeLanes />
        </div>
        <div className="mt-[22px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <Bullets
              items={[
                "向量检索擅长语义，不擅长字符串：确切的名字、ID、生僻词、错字。全文检索恰好相反。三元组捡起两者都漏掉的那些。",
                "倒数排名融合（RRF）从每一路各取 1 / (60 + 名次) 相加，于是三种互不可比的分数，永远不需要被归一化到同一个尺度上。",
              ]}
            />
            <div className="space-y-[14px]">
              <Rows
                rows={[
                  ["每一路的候选数", "50"],
                  ["RRF 常数", "k = 60"],
                  ["三元组阈值", "词相似度 > 0.3"],
                  ["重排后留下", "6 条，进系统指令"],
                ]}
              />
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 10 */
  {
    id: "not-a-silver-bullet",
    title: "向量库不是万能的",
    node: (
      <Slide>
        <Eyebrow icon={BrainCircuit} tone="violet">
          一个过去 · 它的边界
        </Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>向量数据库不是万能的。</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1.05fr 0.95fr" gap={48} align="start">
            <Bullets
              items={[
                "最近邻检索只回答一个问题：这个东西像什么？它回答不了某件事是不是真的、做完没有、周四到期的是哪一件。",
                "问向量索引某个任务完成了没有，它会递给你三个「听起来最像」的任务。对状态来说，差不多恰恰就是错。",
                "所以 EverVault 两种都用，装在同一个 Postgres 里。对话、摘要、文件按语义向量化检索；任务、生活事件、个人档案、账号、配置，是有主键、有日期、有约束的普通关系行。",
              ]}
            />
            <div className="space-y-[16px]">
              <Card title="分界线在哪">
                如果一个「差不多」的答案仍然有用，就把它向量化；如果一个「差不多」的答案是个 bug，就把它放进表里。待办清单是最清楚的例子：一个截止日期、一个完成标记、一个唯一键。每一个都必须精确，每一个都不能近似。
              </Card>
              <Note>
                因为 pgvector 是扩展而不是独立服务，一条记忆和它产生的那个任务是在同一个事务里写下的，而不是两个系统之间的同步。
              </Note>
            </div>
          </Cols>
        </div>
        <div className="mt-[22px]">
          <Note>
            这就引出了下一个问题：检索能找到一行，却写不了一行。那需要一双手。
          </Note>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 11 */
  {
    id: "tool-calling",
    title: "工具调用",
    node: (
      <Slide>
        <Eyebrow icon={Wrench} tone="violet">
          一双手 · 工具调用
        </Eyebrow>
        <div className="mt-[18px] max-w-[940px]">
          <H2>一个文本进、文本出的模型，怎么可能去搜索网页？</H2>
        </div>
        <div className="mt-[24px]">
          <Cols ratio="1.08fr 0.92fr" gap={48}>
            <div className="space-y-[20px]">
              <Bullets
                items={[
                  "你递给它一份菜单：工具名、一句描述、一份 JSON Schema 参数。",
                  <>
                    回复到一半，它可以不写散文，而是吐出一个结构化的{" "}
                    <Mono>functionCall {"{ name, args }"}</Mono>。那仍然只是文本输出。它什么都还没做。
                  </>,
                  "由你的代码去执行这个函数。HTTP、SQL、读文件，什么都行。然后把结果作为新的一条消息递回去，让它接着往下走。",
                  "循环，直到它用大白话回答你为止。",
                ]}
              />
              <Quote>
                它从来没有搜过网页，也从来没有碰过你的数据库。它只是提出请求，由你的程序去做。模型提议，运行时决定。
              </Quote>
            </div>
            <ToolLoop />
          </Cols>
        </div>
        <div className="mt-[22px]">
          <Note>
            这也是整个安全模型：模型拥有的每一项能力，都是你亲手写下、命名、限定、并且随时可以收回的。
          </Note>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 12 */
  {
    id: "tools",
    title: "12 个工具",
    node: (
      <Slide>
        <Eyebrow icon={Wrench}>落到实处</Eyebrow>
        <div className="mt-[18px] max-w-[940px]">
          <H2>12 个工具。一次定义，处处可用。</H2>
        </div>
        <div className="mt-[28px] grid grid-cols-3 gap-[18px]">
          <Card title="记忆">
            <Chips items={["recall_memory", "find_forgettable_memories", "forget_memories"]} />
          </Card>
          <Card title="你的生活">
            <Chips items={["list_tasks", "add_task", "complete_task", "update_task"]} />
          </Card>
          <Card title="文件">
            <Chips items={["find_files", "send_file"]} />
          </Card>
          <Card title="外部世界">
            <Chips items={["search_web", "fetch_url", "send_link"]} />
          </Card>
          <Card title="反馈给我">
            <Chips items={["record_suggestion"]} />
          </Card>
          <Card title="这个循环">每轮最多 5 次往返。同一轮里的调用并行执行。</Card>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <Note>
              打字和实时语音通话共用同一份声明、同一个分发器，所以新加一个工具，两边同时点亮。
            </Note>
            <Note>
              <Mono>send_link</Mono> 存在的理由值得说出来：在语音回复里，文字就是音频本身，没有它模型只能把一个网址一个字符一个字符念给你听。
            </Note>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 13 */
  {
    id: "tool-traps",
    title: "四个坑",
    node: (
      <Slide>
        <Eyebrow icon={Shield}>落到实处</Eyebrow>
        <div className="mt-[18px] max-w-[940px]">
          <H2>工具循环里，这四件事一定会咬你一口。</H2>
        </div>
        <div className="mt-[28px]">
          <Cols ratio="1.15fr 0.85fr" gap={48} align="start">
            <Numbered
              items={[
                {
                  title: "一个抛异常的工具会杀死整个循环。",
                  body: "所以每个执行函数都返回 JSON 字符串，永不抛出。失败作为一个值回到模型手里，让它自己转述。",
                },
                {
                  title: "分发的兜底分支。",
                  body: "我们的兜底是记忆检索，所以一个没有对应分支的工具名，会被安静地回答掉，而不是报错。每加一个新家族，都必须把它的分支放在兜底之前。",
                },
                {
                  title: "抓回来的网页是攻击者可控的文本。",
                  body: "它被围在「不可信内容」的栅栏里，而且页面内部任何一份栅栏标记的副本都会被改写。否则一个网页只要自己打印出结束标记，后面的内容就都被当成可信的了。",
                },
                {
                  title: "永远不要让模型来确认删除。",
                  body: "forget_memories 什么都不删，它只渲染一张卡片。只有人点下去才真的删，而且删掉的事实会留下墓碑，同一段对话没法把它们重新教回来。",
                },
              ]}
            />
            <Quote cite="web/src/app/webapp/lib/forgetTool.ts">
              在一个删除流程里，模型是最不可信的一方。一个由模型自己写下的「用户已确认」标记，是自我认证，一文不值。
            </Quote>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 14 */
  {
    id: "architecture",
    title: "架构",
    node: (
      <Slide>
        <Eyebrow icon={Server}>它是怎么搭起来的</Eyebrow>
        <div className="mt-[18px] max-w-[940px]">
          <H2>
            一台机器，一个域名，一句 <Mono>make up</Mono>。
          </H2>
        </div>
        <div className="mt-[20px]">
          <Architecture />
        </div>
        <div className="mt-[20px] grid grid-cols-3 gap-[18px]">
          <Card title="全部跑在同一个端口">
            nginx 和前端、后端一起跑在应用容器里，所以站点和 API 同源。将来的移动 App 只需要一个 base URL，也不用处理 CORS。
          </Card>
          <Card title="应用容器是可丢弃的">
            一次部署把它整个换掉。数据库是另一个从不停止的容器，所以每次发版数据都还在。
          </Card>
          <Card title="没有第二个存储">
            记忆、文件、配置、加密后的密钥，全都在同一个 Postgres 里。向量检索是一个扩展，不是一个服务。
          </Card>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 15 */
  {
    id: "write-path",
    title: "写入链路",
    node: (
      <Slide>
        <Eyebrow icon={Server}>它是怎么搭起来的</Eyebrow>
        <div className="mt-[18px] max-w-[940px]">
          <H2>写入链路：一段对话怎么变成记忆。</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1.05fr 0.95fr" gap={48} align="start">
            <Bullets
              items={[
                "抽取跑在浏览器里，用的是和聊天同一个模型。服务端既不做向量化，也不做抽取。",
                "触发时机：一轮对话结束 20 秒后（且至少已有 4 轮是新的）、标签页隐藏时、挂断通话时、以及开一段新对话时。",
                "窗口：最近 20 轮，通话之后是 60 轮，锚在一个游标上。调用失败会把游标回退，而不是把这个窗口丢掉。",
                "一次调用同时返回事实、任务完成、状态变化、生活事件，以及一段简短的摘要。",
              ]}
            />
            <div className="space-y-[18px]">
              <Card title="覆盖靠的这个锚">
                <Mono>UNIQUE (user, category, key)</Mono>。重新学到一个事实是覆盖它，而不是堆出一串各答对一半的近似重复。
              </Card>
              <Quote cite="web/src/app/webapp/lib/digest.ts">
                周报摘要补上的是中间那一层：把一整周讲成一段简短的叙述，于是一个跨度很长的问题拿到的是故事，而不是碎片。
              </Quote>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 16 */
  {
    id: "read-path",
    title: "读取链路",
    node: (
      <Slide>
        <Eyebrow icon={Server}>它是怎么搭起来的</Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>读取链路，以及召回的记忆该放在哪里。</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <div className="space-y-[18px]">
              <Bullets
                items={[
                  "每一轮都自动做：用最近 3 轮加当前这条消息拼出查询，跑混合检索，重排，留 6 条。",
                  "另外，模型也可以自己调用 recall_memory，去做一次明确的查找或者按日期范围检索。",
                ]}
              />
              <Card title="决定了这个设计的那个 bug">
                召回的记忆原本是作为对话注入的。有个用户说把一个域名注册加进清单，结果收到的回复是「好的，联系锁匠修门锁这件事已经在你 8 月 13 日的清单上了」。他真正的请求原封不动，两天前的那个却被替他回答了。
              </Card>
            </div>
            <div className="space-y-[18px]">
              <Quote cite="web/src/app/webapp/lib/recall.ts">
                召回的记忆是事实依据，不是对话。所以现在它去了其它事实依据待的地方。
              </Quote>
              <Rows
                rows={[
                  ["注入到", "系统指令里"],
                  ["余弦阈值", "0.6，另加一个相对阈值"],
                  ["时效衰减", "48 小时，之后 30 天半衰"],
                  ["去重", "Jaccard 0.6"],
                ]}
              />
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 17 */
  {
    id: "voice-thesis",
    title: "它不是 LLM",
    node: (
      <Slide>
        <Eyebrow icon={Mic}>交互</Eyebrow>
        <div className="mt-[16px] max-w-[1020px]">
          <H2>
            Live 模型<Grad>不是一个装上了嘴的 LLM</Grad>。
          </H2>
        </div>
        <div className="mt-[22px]">
          <Cols ratio="1.08fr 0.92fr" gap={48}>
            <LiveModelIO />
            <div className="space-y-[16px]">
              <Bullets
                items={[
                  "十二页之前，这张图是一个输入、一个输出，外加三个叉。同一个模型家族，往上一档，产品的形状就跟着变了。",
                  "它不是把你转写完再去读那份稿子。音频本身就是输入，所以语气、迟疑、话说到一半停住，全都活着到达对面。",
                ]}
              />
              <Note>
                用的是 Gemini 3.1 Flash Live，一个原生音频模型。这类模型只支持音频回复，所以那两份转写是官方给出的、把文本取出来的方式，而不是第二个答案。也不碰密钥：浏览器拿一个短期令牌直连服务商，你的音频从不到达我的服务器。
              </Note>
            </div>
          </Cols>
        </div>
        <div className="mt-[24px]">
          <Quote>
            接下来四页里的每一个交互决定，都从这一张图里长出来。改变模型能接收什么，你就改变了产品能是什么。
          </Quote>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 18 */
  {
    id: "voice-latency",
    title: "它不等你",
    node: (
      <Slide>
        <Eyebrow icon={Mic}>交互</Eyebrow>
        <div className="mt-[14px] max-w-[1020px]">
          <H2>
            而且它<Grad>不等你说完</Grad>。
          </H2>
        </div>
        <div className="mt-[20px]">
          <VoicePipelines />
        </div>
        <div className="mt-[20px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <Bullets
              items={[
                "用纯文本模型，你不停下来什么都开始不了：上传、转写、生成、合成，严格按顺序排队。这个等待是结构造成的，不是代码慢。",
                "原生音频模型是实时听你说的，所以它可以在你把那句话说完之前就开始推理，并且去调用 recall_memory 或者 search_web。",
              ]}
            />
            <div className="space-y-[16px]">
              <Card title="所以它才像是瞬时的">
                等你话音落下，工具的结果已经回来了，第一个音节大约一秒后就到。不是因为模型更快，而是因为大部分活儿是在你还在说的时候干完的。
              </Card>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 19 */
  {
    id: "voice-message",
    title: "留出思考的余地",
    node: (
      <Slide>
        <Eyebrow icon={Mic}>交互</Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>
            实时通话给你的思考上了一个时钟。<Grad>语音消息没有。</Grad>
          </H2>
        </div>
        <div className="mt-[20px]">
          <Cols ratio="1.05fr 0.95fr" gap={48} align="start">
            <div className="space-y-[14px]">
              <Bullets
                items={[
                  "在任何一个平台上，实时通话里你停顿一秒去想，模型就把这段沉默读成你说完了。它开始讲，而且讲很久。",
                  "于是你学会不停顿，学会张嘴之前先把整句话想好。语音活动检测悄悄给「思考」上了一道税。",
                  "语音消息把这个时钟还给你。你按住不放，你准备好了才松手，除了你没有任何东西来判定这一轮结束了。",
                  "而且速度一点没让：底下是同一条流式会话，不是上传文件。",
                ]}
              />
            </div>
            <div className="space-y-[14px]">
              <Card title="说进去，说出来">
                一个人既然选择了说，他也就选择了听。语音消息换回来的是语音，旁边配上文字，而不是一大段现在还得读的散文。
              </Card>
              <Card title="它还扛得住吵闹的环境">
                通话必须持续地听，房间里发生什么它都收进去。把手机凑到嘴边说几秒钟不会。同一个模型，信噪比完全不同——所以在公交车上语音消息还能用，通话不行。
              </Card>
              <Quote>
                我用得最多的交互，也是只有自己做这个 App 才可能拿到的。在别的地方，它连一个设置项都不是。
              </Quote>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 20 */
  {
    id: "barge-in",
    title: "打断",
    node: (
      <Slide>
        <Eyebrow icon={Mic}>交互</Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>让人能打断 AI，而 AI 不会打断它自己。</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <div className="space-y-[18px]">
              <Bullets
                items={[
                  "手机外放的时候，模型听得见自己的声音。朴素的语音活动检测会让它一句话说到一半自己打断自己，永远如此。",
                  "靠判断平台没有用。同一部手机在车里和在卧室里的回声完全不同。所以别猜，去测。",
                ]}
              />
              <Quote cite="web/src/app/webapp/lib/bargeIn.ts">
                回声按定义就是我们自己输出的副本：把输出调小，它在几毫秒内就消失。用户的声音不会。
              </Quote>
            </div>
            <div className="space-y-[18px]">
              <Card title="先触发，再探一下">
                连续两个音频块超过学习到的回声耦合系数的 2.2 倍，触发就位。输出压低约 240 毫秒。还是很响，说明是真人在说话，那就确认打断；安静下去了，说明那是回声，恢复播放，并把这次读数并回估计值里。
              </Card>
              <Note>
                耦合系数是每次通话里现学的，所以第十次打断判断得比第一次准。而当输出本来就是静音时，探测这一步直接跳过，打断是瞬时的。
              </Note>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 21 */
  {
    id: "three-fixes",
    title: "三个修复",
    node: (
      <Slide>
        <Eyebrow icon={Mic}>交互</Eyebrow>
        <div className="mt-[16px] max-w-[1000px]">
          <H2>三个只有拿到源码才修得了的问题。</H2>
        </div>
        <div className="mt-[22px]">
          <Cols ratio="1.25fr 0.75fr" gap={44} align="start">
            <Numbered
              items={[
                {
                  title: "iPhone 上语音回复是静音的。",
                  body: "iOS 只有在某个 audio 元素曾经在用户手势里开始播放过之后，才解锁自动播放；而麦克风采集期间播放是被抑制的，所以在录音键上做预热永远不生效。改成在用户第一次点任何地方时解锁，那时还不存在任何采集，播十毫秒的静音就够了。",
                },
                {
                  title: "服务商把实时通话截在十分钟左右。",
                  body: "它会在对话中途关掉连接，而且会先给个预告。所以客户端一直留着最新的恢复句柄，在关闭时重连并把句柄递回去：新的连接接着同一段对话，上下文完整；再配上滑动窗口压缩，几个小时的通话也不会撞上模型的上下文天花板。人聊一个小时，从头到尾看不出接缝。",
                },
                {
                  title: "开着的通话，静音也在计费。",
                  body: "晚上躺着跟它说话，你会带着一个还开着的连接睡过去。于是有个空闲监视器替你挂断，但只有「用户该说话却没说」的时间才算数：模型在说话时窗口会重置，重连进行中也会重置，因为一个朴素的「N 秒没声音」会在模型长篇大论的中间把电话挂掉。",
                },
              ]}
            />
            <div className="space-y-[16px]">
              <Quote>
                每一个都只有几十行。也都是那种在别处只能提个反馈、然后干等的事情。
              </Quote>
              <Note>
                没有一个是有人要求的。这三个加起来，就是「会一直用」和「只试一次」的差别。
              </Note>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 22 */
  {
    id: "cost",
    title: "近乎零成本地跑起来",
    node: (
      <Slide>
        <Eyebrow icon={Coins}>运维</Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>
            跑一个自己的 AI 要花多少钱：<Grad>几乎不要钱</Grad>。
          </H2>
        </div>
        <div className="mt-[28px] grid grid-cols-3 gap-[18px]">
          <Card title="机器">
            <Ext href="https://www.oracle.com/anz/cloud/free/">Oracle Cloud 永久免费层</Ext>。4 核 CPU、24 GB 内存、200 GB 磁盘、4 Gbps 带宽。足够跑下整套东西，而且是长期免费。
          </Card>
          <Card title="语音、语音识别与向量">
            实时通话、语音转文字、文字转语音、向量化、记忆抽取，全都跑在池化的 Gemini 免费额度密钥上。每次对话的边际成本基本是零。
          </Card>
          <Card title="文字回复">
            要最聪明的回答时，用 GPT-5.6，走我本来就在付的每月 20 美元订阅，由后端通过 OAuth 接入。令牌从不到达浏览器，而更便宜的模型档位又把剩下的价格砍掉约 80%。
          </Card>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <Bullets
              items={[
                "池化密钥意味着撞上配额墙时是轮换到下一个密钥，而不是变成用户看得见的报错。",
                "网页搜索先走 Brave，退化到同一批免费密钥上的检索增强生成，所以限流的结果是搜得慢一点，而不是搜不了。",
              ]}
            />
            <Quote>
              存下一整个人生，跑起来的成本是一个域名，加上一个周末的一小时。
            </Quote>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 23 */
  {
    id: "ops",
    title: "用聊天来运维",
    node: (
      <Slide>
        <Eyebrow icon={Rocket}>运维</Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>我不 SSH 上去。我给它发消息。</H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <div className="space-y-[18px]">
              <Quote cite="仓库里 CLAUDE.md 的一条规则">
                这个项目的目标，是尽可能由 AI 来开发和维护，人只做最少的动作。优先选择合理的默认值和自动化，而不是需要人去执行的步骤。
              </Quote>
              <Bullets
                items={[
                  "服务器上跑着一个 agent。我在 Telegram 上给它发一句：备份数据库、把 GitHub 上最新的部署上去。整个流程里没有终端。",
                  "这也正是为什么运行时配置是走管理页进加密数据库，而不是进 .env、不是落在磁盘上的某个文件里。因为根本没有一个人坐在命令行前面去编辑它。",
                ]}
              />
            </div>
            <div className="space-y-[18px]">
              <Card title="部署故意做得很无聊">
                在旧容器还在跑的时候把新容器建起来，用它自己的端口验证一遍，把隧道切过去，再把旧的删掉。真正的停机时间就是隧道重启那几秒。
              </Card>
              <Card title="要坏就坏成一个能查的形状">
                建立在模型之上的管道不可能 100% 成功，所以有用的问题不是怎么杜绝失败，而是失败之后你多快能找到它。每一个用户可见的失败都带一个{" "}
                <Mono>EV-XXXXXXXX</Mono> 码，字母表里没有 0、1、I、L、O、U，所以在电话里念出来也不会错。这份报告和它背后那次 AI 调用都写进数据库，列在管理后台里，于是用户念出来的一个码，能直接指到那次失败的调用。服务商的原始报错从不会出现在聊天气泡里。
              </Card>
              <Note>
                34 个迁移全部遵循扩展、迁移、收缩三步，因为一次部署落地的时候，某个人的旧页面还开着。
              </Note>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 24 */
  {
    id: "compounding",
    title: "为什么它会增值",
    node: (
      <Slide>
        <Eyebrow icon={Sparkles} tone="violet">
          它值得做的地方
        </Eyebrow>
        <div className="mt-[18px] max-w-[1000px]">
          <H2>
            记忆是唯一一个会<Grad>增值</Grad>的功能。
          </H2>
        </div>
        <div className="mt-[26px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <div className="space-y-[18px]">
              <Bullets
                items={[
                  "其它每一个功能，第一千天和第一天一样好用。记忆恰好相反：第一周几乎没用，到第三年无可替代。",
                  "你跟它说得越多，它装下的你就越多。不只是发生了什么，还有你怎么看这件事。",
                  "这种不对称，就是「必须是自己的」的全部理由。三年的「被理解」，你没法从别人的产品里导出来。",
                ]}
              />
            </div>
            <div className="space-y-[18px]">
              <Card title="它会长成什么：一个 AI 版本的你">
                当发生在你身上的事、以及你对这些事的看法都攒够了，这份记忆装下的就不只是你的事实，而是你怎么推理。于是家人想找你说话而你没有时间时，他们可以去跟那个已经听了你三年的版本聊。不是一个套着你名字的聊天机器人：是你的经历，和你得出结论的方式。
              </Card>
              <Note>这是我最没把握做对、也最想做的一部分。</Note>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 25 */
  {
    id: "ceiling",
    title: "模型才是天花板",
    node: (
      <Slide>
        <Eyebrow icon={Sparkles} tone="violet">
          我真正学到的
        </Eyebrow>
        <div className="mt-[18px] max-w-[1020px]">
          <H2>
            你能做出的交互，<Grad>被你手上的模型封顶</Grad>。
          </H2>
        </div>
        <div className="mt-[24px]">
          <Cols ratio="1.05fr 0.95fr" gap={48} align="start">
            <Bullets
              items={[
                "GitHub Copilot 2021 年上线时是自动补全，跑在 Codex 上。不是因为 agent 是个更差的主意，而是那个模型能写完一个函数，却撑不住一个跨越整个仓库的计划。它是当时那个模型的正确产品。",
                "Agent 模式直到 2025 年 2 月才出现。三年半，好几代模型，换来的是一个 2021 年所有人就已经想得出来的功能。调试、代码评审、Pull Request 都是同一个路数：模型扛得住了才出现，而不是有人先想到了才出现。",
                "这场分享里的每一个决定，都压在同一个天花板上。能打断，是因为模型是流式的。语音消息是一次调用，是因为模型原生吃音频和图片。召回敢不问自动跑，是因为抽取可靠到能在无人看管时被信任。",
                "两年前，这些里有一半会是做得很好的坏主意。",
              ]}
            />
            <div className="space-y-[16px]">
              <Card title="所以要为下一个天花板做，而不是这一个">
                这会改变你优化的目标：在模型和人之间放尽可能少的脚手架，好让天花板抬升的时候，产品跟着一起升，而你删代码而不是写代码。在这里，它具体意味着一份工具定义服务所有入口、记忆只是 Postgres 里的几行，以及模型本身是管理页上的一个下拉框，而不是代码里的一个假设。
              </Card>
              <Quote>
                EverVault 的路线图其实不是我的。它是模型的，而我在做那个能沾上光的部分。
              </Quote>
            </div>
          </Cols>
        </div>
      </Slide>
    ),
  },

  /* ----------------------------------------------------------------- 26 */
  {
    id: "close",
    title: "结尾",
    node: (
      <Slide>
        <Eyebrow icon={Sparkles}>它要去哪</Eyebrow>
        <div className="mt-[20px] max-w-[1000px]">
          <H2>
            还是那两件事，对你也一样：<Grad>一份属于你的记忆</Grad>，和一个你有权去修的交互。
          </H2>
        </div>
        <div className="mt-[28px]">
          <Cols ratio="1fr 1fr" gap={48} align="start">
            <div className="space-y-[20px]">
              <Body>
                这场分享中间的几乎每一页，最初都只是某个星期二惹恼我的一件小事。这就是「自己做一个」的全部理由。
              </Body>
              <Chips
                items={["克隆你自己的声音", "用电话提醒你", "按你的节奏找你聊", "一份留得住的记忆"]}
              />
            </div>
            <div className="rounded-[18px] border border-black/10 bg-white/70 p-[28px] text-center shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
              <div className="text-[length:var(--dk-stat)] font-semibold tracking-tight">
                <Grad>evervault.life</Grad>
              </div>
              <div className="mt-[12px] text-[length:var(--dk-sm)] text-black/55 dark:text-white/55">
                开源，AGPL-3.0。可以直接在浏览器里试，也可以自己跑起来。
              </div>
              <div className="mt-[18px] font-mono text-[length:var(--dk-xs)] text-black/40 dark:text-white/40">
                make up
              </div>
            </div>
          </Cols>
        </div>
        <div className="mt-[34px]">
          <Note>谢谢。欢迎提问。</Note>
        </div>
      </Slide>
    ),
  },
];

// The language switch keeps the current slide index, and the overview grid indexes both arrays by
// position, so the two decks drifting out of step would silently show the wrong slide rather than
// fail. Catch it at module load instead, where the message names the problem.
if (process.env.NODE_ENV !== "production") {
  if (SLIDES_ZH.length !== SLIDES.length) {
    console.error(
      `[deck] slide count mismatch: ${SLIDES.length} English, ${SLIDES_ZH.length} Chinese.`,
    );
  } else {
    const drifted = SLIDES.map((s, i) => [s.id, SLIDES_ZH[i].id]).filter(([a, b]) => a !== b);
    if (drifted.length) {
      console.error("[deck] slide id mismatch between languages:", drifted);
    }
  }
}
