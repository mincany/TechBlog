---
title: "0.1 · 算力层的四层心智模型"
titleZh: "The 4-Layer Mental Model for AI Compute"
description: "一个把算力集群拆成四层——预留、置备、调度、工作负载——的简单模型，让「我的 Pod 卡在 Pending」从三方扯皮变成一分钟就能定位的诊断。"
date: "06/29/2026"
---

这是我正在写的一个关于 GPU 容量与调度系列的开篇基础文章——它是我反复回到的那个心智模型，也是后面所有文章的地基。

## TL;DR

一个 GPU 集群并不是单一系统，而是**四个叠在一起的系统**；我见过的几乎每一次让人头疼的线上事故，都源于把其中两层搞混了。这四层是：

1. **容量供给（Capacity supply）**——你拥有使用权的一块*预留资源池*。
2. **置备（Provisioning）**——把这块资源池变成*真正在运行的机器*（节点）。
3. **调度（Scheduling）**——把*工作单元*（Pod）放到这些机器上。
4. **工作负载（Workload）**——真正消耗 GPU 的训练或推理任务。

需要记住的一点：这是四个*不同的*系统，通常由不同的人负责——在你能把它们分开命名之前，你其实没法真正地推理一个 GPU 集群。

## 写作动机：先有地图，再谈地形

这里没有什么惊心动魄的故事——我想先把这点说清楚。这是一篇打地基的文章：它是后面整个系列依赖的心智模型，老实说，也是我当初刚开始拼凑 GPU 基础设施时，希望有人能先帮我画出来的那张图。真正的故事在后面——co-location、抢占、回收——这篇只是让那些故事读起来有意义的共同词汇。

它要解决的日常痛点是这样的：「我的 Pod 卡在 Pending」大概是关于 GPU 集群最常被说起的一句话——而它作为一个描述几乎毫无用处，因为 *Pending* 可能意味着四件完全不同的事，分别由四拨不同的人负责：

- 容量团队说「预留是 active 的，我们在付费」
- 平台团队说「有 Pod 处于 Pending」
- 调度器说「我没有任何地方可以放它们」

三句话可以同时成立，而每一句指向不同的一层。没有一张共同的地图，这场对话只会原地打转；有了地图，一句话就能定位。这篇文章就是那张地图。（真正去*调试*这个 Pending 症状是另一篇——0.3；这里我只想要地图本身。）

## 开始之前

如果你大致知道 Kubernetes 的 Pod 和 Node 是什么、以及 GPU 是一种可以被*申请*的资源，你会读得最顺。不需要任何特定的调度器；demo 只需要 `kind` 加任意一个容器运行时（Docker / Podman / Colima）——不需要 GPU 硬件。读完之后，你应该能在大约一分钟内，把任何「我的 Pod 卡住了」的问题对应到正确的那一层。

## 心智模型（一张图）

```
                         WHAT IT IS              FAILS LOOK LIKE
  ┌─────────────────────────────────────────────────────────────────────┐
  │ L4  WORKLOAD          the training / inference   "loss diverged",     │
  │     (consumes GPUs)   job that burns the GPU      OOM, NCCL hang      │
  ├─────────────────────────────────────────────────────────────────────┤
  │ L3  SCHEDULING        place / share / preempt      pod Pending:       │
  │     (the scheduler)   units of work onto nodes     "no node fits"     │
  ├─────────────────────────────────────────────────────────────────────┤
  │ L2  PROVISIONING      turn the pool into            node NotReady,    │
  │     (autoscaler)      actual running machines       launch stuck      │
  ├─────────────────────────────────────────────────────────────────────┤
  │ L1  CAPACITY SUPPLY   the reserved pool of          "no capacity",    │
  │     (reservations)    hardware you can claim        alloc errors      │
  └─────────────────────────────────────────────────────────────────────┘
            ▲                                                    │
            └──────── the SEAM (L1 ↔ L3): pool ⇄ schedulable ────┘
                      where paid-for capacity goes idle
```

从下往上读，因为容量实际就是这样流动的：

| 层 | 名词 | 它回答的问题 | 通常归谁负责 |
|---|---|---|---|
| **L1 容量供给** | 一块*预留资源池* | 「我到底有没有对硬件的使用权？」 | 容量 / FinOps |
| **L2 置备** | 一台*运行中的机器* | 「这份使用权是不是一个就绪（Ready）的节点？」 | 平台 / autoscaler |
| **L3 调度** | 一个*工作单元* | 「这个 Pod 会被放到某个节点上吗？」 | 调度器 / 平台 |
| **L4 工作负载** | 那个*任务* | 「放上去的活儿跑得对不对、值不值？」 | ML 团队 |

诀窍在于：**症状几乎总是出现在 L3**（「我的 Pod 卡在 Pending」），无论真正出问题的是哪一层。L3 只是那个报信的人。这个模型的作用，就是让你别再迁怒于报信的人。

## 逐层拆解

**L1 — 容量供给。** 这是对硬件的*使用权*，而不是正在运行的硬件。一个预留、一个 capacity block、一份配额。关键性质：**你可能在 L1 已经开始付费，却在 L2 一无所有。** 一块「active」但还没变成节点的预留资源池，就是纯成本、零能力。这里的失败听起来像「容量不足」——每家云都有自己的叫法（AWS `InsufficientInstanceCapacity`、GCP `ZONE_RESOURCE_POOL_EXHAUSTED`、Azure `AllocationFailed`）——或者干脆「配额是零」。

**L2 — 置备。** 这一步把使用权变成一个 `Ready` 的节点。autoscaler 向 L1 要机器，然后等 30 秒到 5 分钟，让它启动、加入集群、通过健康检查。这里的失败：节点卡在 `NotReady`；或者 GPU 驱动 / device plugin 还没装好；或者启动一直挂着。从 L3 的视角看，一个还在置备中的节点*根本不存在*。

**L3 — 调度。** 有了就绪的节点，决定哪个 Pod 放到哪里：过滤（哪些节点*放得下*）、打分（哪个*最合适*）、绑定。真正丰富的问题都在这一层——gang 调度、公平性、抢占、拓扑——也是这个系列大部分篇幅要讲的。但要注意：**L3 只能把活儿放到 L2 从 L1 的资源池里真正产出的节点上。它变不出容量。**

**L4 — 工作负载。** 任务本身：并行方式、checkpoint、KV-cache、batching。一个调度得完美的任务，仍然可能把 GPU 的大部分算力浪费掉——Model FLOPs Utilization（MFU）远低于 1.0；即使是调得很好的大型训练，也常常只落在 40–55% 一带——而这是 L4 / 效率问题，不是调度问题。另一篇文章，另一种解法。

**关于 L1↔L3 之间那道缝的提醒。** 这两层通常由*不同的团队、看不同的看板*负责——L1 的看板说「预留 active，$X/小时」，L3 的看板说「N 个 Pod 处于 Pending」。没有哪个看板显示它们*之间*的那段差距：已经付费、却从未变得可调度的容量。这道缝特别容易被所有人忽略，恰恰因为没有任何一层真正拥有它。

### 模型会在哪里漏（因为没有哪个四格模型是全部真相）

两个诚实的提醒，免得这个模型在边角处误导你：

- **DaemonSet 和 static pod 并不真的玩 L3 这套游戏。** 它们按设计就被放到每个（或某个特定）节点上，绕过了过滤 / 打分的竞争。「所有症状都在 L3 表现为 Pending」这条规则，说的是*用户工作负载*争抢稀缺 GPU——不包括系统 Pod。
- **Dynamic Resource Allocation（DRA）模糊了 L2 和 L3。** 随着 DRA 在 Kubernetes 中成熟（结构化参数的资源申领），一些这个模型归到 L2/置备的分配决策，其实发生在调度*过程中*。四层依然是一张有用的地图；只是要知道 L2↔L3 这条线在变模糊，而不是变清晰。

如果你的问题正好落在这些角落里，这个模型会把你指到大致的街区，然后礼貌地退到一边。

## Demo：在一台笔记本上看清四层

实话说明：这个 demo 跑在 `kind`（Kubernetes 跑在 Docker 里）上，GPU 是*假造*到节点上的——没有真实硬件。目的是把四层看成四个*各自独立、可观察*的东西，而不是给 GPU 跑分。下面每一条命令和输出都来自一次真实运行（kind v0.32，Kubernetes v1.36.1）。如果你不熟悉 `kubectl`，每一步都会说明它做了什么、你该看到什么。

关键选择：用一个**多节点**集群，这样调度器才真有地方可以*在其中做选择*——这正是让 L3 变得可见、而不是靠脑补的原因。

**搭建——一个 3 节点集群（1 个 control-plane + 2 个 worker）。**

```bash
cat > kind-layers.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF

kind create cluster --name layers --config kind-layers.yaml
# 新建的节点会短暂处于 NotReady（一个会自动消失的 taint）；等它们就绪。
kubectl wait --for=condition=Ready nodes --all --timeout=90s
```

```
node/layers-control-plane condition met
node/layers-worker condition met
node/layers-worker2 condition met
```

三台机器，零个 GPU。（如果后面某个 `apply` 报 `serviceaccount "default" not found`，说明集群还在启动——等几秒重试即可。）

**L1 — 容量供给：预留。** 在任何 GPU 存在之前，你先持有一个*预留*——一份对尚未变成可用节点的硬件的使用权。在云上，这就是 AWS Capacity Block for ML、GCP 的 future/calendar reservation，或 Azure 的 capacity reservation；对于像 H200 或 GB200 这样紧缺的型号，**没有预留你基本上根本起不来一块 GPU**。`kind` 没有「预留」这个原语，所以这里的预留用这样一个事实来表示：我们的 worker 节点*存在*，但对外宣告的可调度 GPU 是**零**——使用权在手，但还没有任何东西能在上面跑：

```bash
WORKER=$(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' \
          -o jsonpath='{.items[0].metadata.name}')
kubectl get node "$WORKER" -o jsonpath='gpu=[{.status.capacity.nvidia\.com/gpu}]{"\n"}'
```

```
gpu=[]
```

空的。节点在那儿（预留持有着），但它还不提供任何 GPU。*这正是一块付了费的预留可能在烧钱的那道缝——你握着 H200，却没有任何东西被调度上去。*

**L2 — 置备：把预留变成可调度的 GPU。** 在云上，autoscaler 启动那台预留的实例，它加入集群，它的 GPU **device plugin** 把 GPU 宣告给 Kubernetes——正是这一步让预留的容量真正*可被调度*。`kind` 的机器已经在那儿了，所以我们用「在每个 worker 上宣告一块 GPU」来替代 device plugin：

```bash
for n in $(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' \
            -o jsonpath='{.items[*].metadata.name}'); do
  kubectl patch node "$n" --subresource=status --type=json \
    -p '[{"op":"add","path":"/status/capacity/nvidia.com~1gpu","value":"1"}]'
done

kubectl get node "$WORKER" -o jsonpath='gpu=[{.status.capacity.nvidia\.com/gpu}]{"\n"}'
```

```
node/layers-worker patched
node/layers-worker2 patched
gpu=[1]
```

这个 `gpu=[]` → `gpu=[1]` 的翻转*就是* L1→L2 的边界：一个预留的存在（一份使用权），对比一个节点真正提供出一块调度器可以往上放活儿的 GPU。现在我们有两个 worker，每个一块可调度的 GPU。

**L3 — 调度：调度器*选择*每个 Pod 跑在哪里。** 提交三个 Pod，每个都申请一块 GPU：

```bash
for p in trainer-a trainer-b trainer-c; do
  kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $p
spec:
  containers:
  - name: c
    image: busybox
    command: ["sh", "-c", "sleep 3600"]
    resources:
      limits:
        nvidia.com/gpu: 1
EOF
done

kubectl get pods -o wide      # NODE 列显示的就是调度器的决定
```

```
NAME        READY   STATUS    NODE
trainer-a   1/1     Running   layers-worker2
trainer-b   1/1     Running   layers-worker
trainer-c   0/1     Pending   <none>
```

（真实的 `-o wide` 还会打印 `RESTARTS / AGE / IP / NOMINATED NODE`；这里为了宽度做了精简。）

这就是 L3 在干它真正的活儿。两块 GPU 分布在两个节点上；调度器把 `trainer-a` 和 `trainer-b` **放到了不同的** worker 上——选哪个节点就是那个决策——而把 `trainer-c` 留在 **Pending**，因为两块 GPU 都被占了。放置和 Pending 是同一层的两面：有容量就把活儿放上去，没有就拒绝。

**L4 — 工作负载：在一个运行中的 Pod *里面*跑活儿。** Pod 是调度器填进去的那个坑位；工作负载是在这个坑位里跑的东西。我们已经看着调度器把 `trainer-a` 放到了一个 GPU 节点上（那是 L3）——所以接下来就在*那个同一个 Pod 里*把活儿跑起来，不杀掉、也不重新调度任何东西。`kubectl exec` 会在一个运行中的容器里跑一个进程。我们的工作负载故意搞得很简单——打一个时间戳，「干活」三步，再打一次时间——作为真实训练脚本的替身：

```bash
kubectl exec trainer-a -- sh -c 'echo "[trainer-a] $(date +%H:%M:%S) starting"; for i in 1 2 3; do echo "[trainer-a] step $i"; sleep 1; done; echo "[trainer-a] $(date +%H:%M:%S) done"'
```

```
[trainer-a] 14:53:58 starting
[trainer-a] step 1
[trainer-a] step 2
[trainer-a] step 3
[trainer-a] 14:54:01 done
```

这就是 L4：工作负载跑在这个 Pod 持有的 GPU 上，而且 Pod 自始至终都活着——`kubectl get pods` 仍然显示 `trainer-a` 和 `trainer-b` 处于 `Running`，什么都没被拆掉。注意 `exec` 完全没碰调度器：放置决策（L3）只在 Pod 被创建时发生过*一次*；工作负载只是在这个 Pod 已经占下的坑位里跑。现实里也是这个形状——一个训练 Pod 被调度一次，然后在里面跑很多步。

（另一个常见的做法是 Kubernetes `Job`：它创建*自己的*一个新 Pod，跑到完成，并报告 `Complete`——当你希望系统去*追踪*一个任务是否跑完时很好用。同样是这四层；Job 只是把「调度一个新 Pod」和「跑活儿」捆进了一个对象里，而 `exec` 让我们把这两件事分开来看。）

```bash
kind delete cluster --name layers     # 清理
```

**你刚刚逐层看到的东西：**

| 层 | 我们做了什么 | 看起来是什么样 |
|---|---|---|
| **L1** 容量供给 | 持有一个预留——节点存在，但 GPU 还不可调度 | `gpu=[]` |
| **L2** 置备 | device plugin 在每个 worker 上宣告 GPU | `gpu=[]` → `gpu=[1]` |
| **L3** 调度 | 调度器把 Pod 放到节点上，并拒绝了第三个 | `trainer-a→worker2`、`trainer-b→worker`、`trainer-c Pending` |
| **L4** 工作负载 | 在运行中的 `trainer-a` *里面*跑了工作负载（`exec`） | 打了一个时间戳 + 三步；Pod 一直 `Running` |

四层，四种可观察的行为——而不只是「一个 Pod 需要一块 GPU」。当出问题时，*缺的是这四种行为里的哪一种*，就是整个诊断问题的核心——而这正是这个四层模型给你的东西。

## 小结

四个叠在一起的系统——预留、置备、调度、工作负载——每一个都是一个独立、可观察的东西，而不是一团笼统的「GPU 集群」。实际的好处不大但很实在：出问题时，你能说出*是这四者中的哪一个*，而不用靠猜。后面的每篇文章都会深入其中一层。

---

*这是一个个人博客——观点是我自己的，不代表我的雇主；这里的一切都基于公开文档中的特性。*
