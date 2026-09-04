# 同处聊天完整移除清单

本目录和所有带 `SAME_SPACE_CHAT` 注释的共享接入口共同组成“同处聊天（轻量线下）”。
它不依赖 Date App、Worker、D1、朋友圈或主动消息 2.0。

## 当前独占文件

- `features/sameSpaceChat/model.ts`
- `features/sameSpaceChat/SameSpaceComposer.tsx`
- `features/sameSpaceChat/SameSpaceActionBubble.tsx`
- `features/sameSpaceChat/UNINSTALL.md`
- `utils/sameSpaceChat.test.ts`

## 当前共享接入口

- `types.ts`
- `apps/Chat.tsx`
- `components/chat/ChatInputArea.tsx`
- `components/chat/MessageItem.tsx`
- `utils/chatRequestPayload.ts`
- `utils/chatPrompts.ts`
- `utils/applyAssistantPostProcessing.ts`
- `utils/applyAssistantPostProcessing.test.ts`
- `utils/messageFormat.ts`
- `utils/characterCard.ts`
- `utils/replySnapshotBlobRef.test.ts`

共享接入口均可由 `SAME_SPACE_CHAT`、`sameSpaceChat` 或独占目录导入定位。移除时不得删除或改写
原版 Date App、普通私聊、主动消息、朋友圈、记忆宫殿及其它二改逻辑。

## 一次性移除约定

首版功能必须保持为一个独立 Git 提交；最安全的一次性卸载方式是单独回退提交主题
`feat(chat): add removable same-space chat mode`。以后本功能的每次演进也必须使用只包含同处聊天的
独立提交，并在本文件追加提交主题或提交号。这样用户要求“一键删除”时，可以一次回退登记的同处聊天
提交，而不会连带回退上游或其它二改。

## 移除后验证

1. 全仓不再存在 `SAME_SPACE_CHAT`、`sameSpaceChat` 或 `features/sameSpaceChat` 引用。
2. 运行全量 Vitest。
3. 运行生产构建。
4. 手动检查普通私聊发送、加号面板、模型回复、引用和 Date App 入口。
