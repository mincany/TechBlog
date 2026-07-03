---
title: "0.2 · 为什么我的 Pod 卡在 Pending？深入排查失败路径"
titleZh: "Why Is My Pod Stuck Pending? Looking into the failure path"
description: "GPU 集群里最常见、也最烧钱的一个问题。同样一句 Pending，可能来自四层中的任何一层；这篇教你在花钱修错地方之前，先一分钟定位是哪一层。"
date: "07/01/2026"
---

这是 GPU 容量与调度系列的第二篇。[0.1](/zh/blog/four-layer-capacity-model) 画好了那张地图——把 GPU 集群看成四个叠在一起的层。这篇文章把地图用起来，去解决关于 GPU 集群最常被说起的一句话：*「我的 Pod 卡在 Pending 了。」*

## TL;DR

`Pending` 这一个词，其实对应**四种不同的问题**，每层一种：

- **L1**——根本没有 GPU 池（没有预留，配额为 0）。
- **L2**——节点存在，但还不是一个可调度的 `Ready` 节点。
- **L4**——Pod 的请求永远塞不进任何节点（要 8 张 GPU，或者亲和性规则匹配不到任何节点）。
- **L3**——GPU 是真实存在且 `Ready` 的，只是此刻都被占满了。

关键在于：调度器对其中好几种情况会打印**同一行**——`Insufficient nvidia.com/gpu`——所以光看这条消息，你分不清是哪一层坏了。每一层的修法不同、代价也不同，而每一层都有一个便宜的追问能把它们区分开。判断错了，你可能会花真金白银去买你本来就已经有的容量。

## 动机：在昂贵的修复之前，先问那个便宜的问题

这里没有事故故事——这是一篇打地基的文章，而 `Pending` 正是四层地图最能派上用场的日常症状。但这个模式是真实的：「我的 Pod 卡在 Pending」会同时把三个人引向三个方向。容量负责人去查预留，平台工程师去重启 autoscaler，算法工程师去重读自己的 YAML——而其中只有一个人看对了层。这篇文章的意义，就是在任何人动手之前，先花三十秒搞清楚是**哪一层**。

## 开始之前

你大致知道 Pod 和节点是什么、知道 GPU 是一种*可申请*的资源（`limits: nvidia.com/gpu`）就够了。下面所有内容都跑在 `kind`（在 Docker 里跑的 Kubernetes）上，GPU 是*伪造*到节点上的——不需要 GPU 硬件，也不依赖特定调度器。读完你应该能掌握一套大约一分钟就能走完的四问排查法。

## 心智模型：一棵排查决策树

当一个 Pod 卡在 `Pending`，从上往下走——第一个「否」就是你那一层。每一步都是一个便宜的、只读的问题：

```
                          pod stuck Pending
                                 │
        ┌────────────────────────▼───────────────────────────┐
        │ 任何一个节点上有 GPU 吗？                              │── 否 ─▶  L1  没有池 / 没有容量
        │   kubectl get nodes -o ...nvidia.com/gpu             │         (云上：InsufficientInstanceCapacity, 配额 0)
        └────────────────────────┬───────────────────────────┘
                                 │ 是
        ┌────────────────────────▼───────────────────────────┐
        │ 有 GPU 的节点是 Ready 且可调度的吗？                   │── 否 ─▶  L2  节点 NotReady / 被 cordon / draining
        │   kubectl get nodes   (Ready? SchedulingDisabled?)   │
        └────────────────────────┬───────────────────────────┘
                                 │ 是
        ┌────────────────────────▼───────────────────────────┐
        │ 这个 Pod 有没有可能塞进某个节点？                      │── 否 ─▶  L4  不可能满足的请求
        │   请求 ≤ 某节点的容量？selector 匹配得上吗？           │         (在单卡节点上要 8 卡；错误的 nodeSelector)
        └────────────────────────┬───────────────────────────┘
                                 │ 是
        ┌────────────────────────▼───────────────────────────┐
        │ GPU 只是此刻被占满了吗？                               │── 是 ▶  L3  资源争用
        │   kubectl get pods -o wide  (别的 Pod 正跑在上面?)    │
        └──────────────────────────────────────────────────────┘
```

**为什么是这个顺序？** 每个问题都比下一个更便宜、也更确定。*到底有没有 GPU？* 和 *节点能不能用？* 都是你在 `kubectl get nodes` 里一眼就能读到的静态事实。*这个 Pod 有没有可能塞得进去？* 也还是静态的——拿请求跟某个节点能提供的对比一下就行。只有最后一个问题——争用——需要你去看集群的**实时**状态（此刻到底在跑什么）。而且它是唯一一种集群本身其实是健康的、修复要*花钱*的情况——等待、抢占、或者加机器。所以你先排除掉那些便宜的、结构性的原因，只有在前三个都被排除之后，才下结论说「就是被占满了」。跳过这个顺序，你就有可能用「买你本来就已经有的容量」去「修」一个争用问题。

| 层 | `Pending` 的原因 | 那个便宜的追问 | 「否」意味着什么 |
|----|------------------|----------------|------------------|
| **L1 容量** | 根本没有池 | `get nodes`：任何地方有 GPU 吗？ | 没东西可以调度——你需要容量（或配额） |
| **L2 置备** | 节点不 `Ready`/不可调度 | `get nodes`：`Ready`？`SchedulingDisabled`？ | 容量在，但还不能用——去修节点，不是修池 |
| **L4 工作负载** | 请求塞不进任何节点 | 请求 vs 节点容量；selector | YAML 写错了——加多少容量都没用 |
| **L3 调度** | GPU 存在但都在忙 | `get pods -o wide`：别的在跑吗？ | 是争用——等待、抢占、或加容量 |

## 逐个走一遍这四种原因

**L1——没有池。** 集群根本拿不出任何 GPU：没有预留被变成带 GPU 的节点，或者你的配额是 0。在云上这就是 `InsufficientInstanceCapacity` / `ZONE_RESOURCE_POOL_EXHAUSTED` / 配额 0。判断标志是：`kubectl get nodes` 显示**任何节点上都没有 GPU**——根本没有可以长出来的地方。修它意味着去搞到容量；重启什么的都没用。

**L2——没有就绪的节点。** 容量存在，但承载它的节点*此刻*还不是一个可用的 `Ready` 节点——还在启动、`NotReady`、被 cordon、或者正在 drain，又或者它的 GPU device plugin 还没把 GPU 上报出来。GPU「在那儿」，但调度器用不了。修复点在节点，不在池。

**L4——不可能满足的请求。** Pod 要的东西**没有任何单个节点能满足**：在最大只有 1 卡的节点上要 8 卡，或者一个匹配不到任何节点的 `nodeSelector`/亲和性。这种情况*即使在完全空闲的集群上*也会一直 `Pending`——这恰恰就是识别它的方法。再多容量也修不好一个塞不进去的请求；bug 在 YAML 里。

**L3——争用。** 最「诚实」的一种：GPU 存在，节点 `Ready`，请求也合理——只是它们全都**在忙**。别的 Pod 正 `Running` 在这些 GPU 上，你的只能排队。这是四种里唯一一种「加容量」「等待」「抢占点什么」才是对的动作的情况——也是最常被*误判成 L1* 的那一种。

## 进入 demo 前你需要先懂的一个概念：taint（污点）

下面的调度器消息里到处是 *taint* 这个词，所以值得先花三十秒讲清楚。

**taint（污点）**是打在*节点*上的一个标记，意思是「别把 Pod 放到这儿，除非它明确表示自己可以接受」。Pod 通过携带一个匹配的 **toleration（容忍）**来「报名」。没有 toleration → 调度器就拒绝把这个 Pod 放到那个节点上。taint 就是 Kubernetes 让某些节点不被普通工作负载占用的机制。

这篇文章里出现了两个 taint，而且都是*隐式*帮你设好的——这正是第一次看到时让人困惑的地方：

- **节点的角色（role）会隐含一个 taint。** control-plane 节点会被自动打上 `node-role.kubernetes.io/control-plane:NoSchedule`，好让普通工作负载离它远点。我们的 GPU Pod 不容忍这个 taint，所以对它们来说 control-plane *永远*被排除。这就是你在下面每一条消息里都会看到的 `1 node(s) had untolerated taint(s)`——那「1 个节点」就是 control-plane。
- **`cordon` 会设一个 taint。** `kubectl cordon <node>` 把一个节点标记为不可调度；它在底层加了 `node.kubernetes.io/unschedulable:NoSchedule` 这个 taint，节点随之显示为 `Ready,SchedulingDisabled`。新 Pod 不会被放上去（已经在跑的 Pod 留着不动）。`kubectl uncordon <node>` 把它去掉。这是运维把一个节点「拉出轮换」又不杀掉上面东西的日常做法。

所以当调度器说 `0/N nodes are available: ...` 时，它列的是**它正要放置的那一个 Pod，被每个节点拒绝的所有理由**——包括没被容忍的 taint。记住这点：这些计数永远是*针对某一个 pending 的 Pod*，而不是在统计有多少个 Pod 失败了。

## Demo：把一个集群用四种方式弄崩

我们会在同一个小集群上制造出每一种原因，顺序就是**你实际排查时会走的顺序**——没有池（L1）、节点不可用（L2）、不可能的请求（L4）、真正的争用（L3）。下面每条命令和输出都来自一次真实运行（`kind` v0.32，Kubernetes v1.36.1）；GPU 是伪造到节点上的，所以不需要硬件。

下面每条调度器消息都以 `1 node(s) had untolerated taint(s)` 开头——那是 control-plane，被它的 role taint 排除了（见上面那一节）。在不同原因之间*变化*的是这行剩下的部分，所以那才是要读的地方。（为了排版，我把结尾的 `preemption: ...` 截断成了 `…`。）

**准备——一个 3 节点集群（1 control-plane + 2 worker）。**

```bash
cat > kind-pending.yaml <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF

kind create cluster --name pending --config kind-pending.yaml
kubectl wait --for=condition=Ready nodes --all --timeout=120s
```

```
node/pending-control-plane condition met
node/pending-worker condition met
node/pending-worker2 condition met
```

**原因 L1——任何地方都没有 GPU。** 刚建好的 `kind` 节点不上报任何 GPU，所以这本身*就是*「没有池」的状态。先看一眼，再提交一个要 1 张 GPU 的 Pod：

```bash
kubectl get nodes -o 'custom-columns=NODE:.metadata.name,GPU:.status.capacity.nvidia\.com/gpu'
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: l1-no-capacity }
spec:
  containers:
  - name: c
    image: busybox
    command: ["sh","-c","sleep 3600"]
    resources: { limits: { nvidia.com/gpu: "1" } }
EOF
kubectl describe pod l1-no-capacity | sed -n '/Events:/,$p'
```

```
NODE                    GPU
pending-control-plane   <none>
pending-worker          <none>
pending-worker2         <none>

Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  4s    default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient nvidia.com/gpu. …
```

节点表就是全部答案：每个节点的 `GPU` 都是 `<none>`。根本没有可以调度的地方。记住这条消息——`2 Insufficient nvidia.com/gpu`——因为你待会儿会因为完全不同的原因再次见到它。

**原因 L2——节点不可调度。** 现在给每个 worker 一张 GPU（代替「预留实例起来后 device plugin 上报 GPU」这一步），然后把两个都 `cordon` 掉——容量在，但节点不接活：

```bash
for n in pending-worker pending-worker2; do
  kubectl patch node "$n" --subresource=status --type=json \
    -p '[{"op":"add","path":"/status/capacity/nvidia.com~1gpu","value":"1"}]'
  kubectl wait --for=jsonpath='{.status.allocatable.nvidia\.com/gpu}'=1 node/"$n" --timeout=30s
  kubectl cordon "$n"
done
kubectl get nodes
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: l2-unschedulable }
spec:
  containers:
  - name: c
    image: busybox
    command: ["sh","-c","sleep 3600"]
    resources: { limits: { nvidia.com/gpu: "1" } }
EOF
kubectl describe pod l2-unschedulable | sed -n '/Events:/,$p'
```

```
NAME                    STATUS                     ROLES           AGE   VERSION
pending-control-plane   Ready                      control-plane   35s   v1.36.1
pending-worker          Ready,SchedulingDisabled   <none>          21s   v1.36.1
pending-worker2         Ready,SchedulingDisabled   <none>          21s   v1.36.1

Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  4s    default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) were unschedulable. …
```

一条*不一样*的消息——`2 node(s) were unschedulable`。这就是 cordon 那个 taint 在说话：`kubectl get nodes` 把两个 worker 显示成 `Ready,SchedulingDisabled`，所以即便它们有 GPU，调度器也跳过它们。容量是真的；只是节点不在轮换里。把它们放回去，好让后面两种原因有地方跑，并清掉这个 Pod：

```bash
kubectl uncordon pending-worker pending-worker2
kubectl delete pod l2-unschedulable
```

**原因 L4——一个塞不进去的请求。** 现在集群空闲，有两张空 GPU。要 8 张 GPU，而没有任何节点超过 1 张：

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: l4-too-big }
spec:
  containers:
  - name: c
    image: busybox
    command: ["sh","-c","sleep 3600"]
    resources: { limits: { nvidia.com/gpu: "8" } }
EOF
kubectl describe pod l4-too-big | sed -n '/Events:/,$p'
```

```
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  4s    default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient nvidia.com/gpu. …
```

又是 `2 Insufficient nvidia.com/gpu`——和 L1 在完全没有 GPU 时打印的是同一行。但此刻集群完全空闲，而这个 Pod 会一直 `Pending` 下去：没有任何东西在忙，是请求本身塞不进一个单卡节点。「空闲却仍然 Pending」就是它的判断标志。另一种「不可能的请求」——一个匹配不到任何节点的亲和性规则——则把自己说得更明白：

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: { name: l4-bad-affinity }
spec:
  nodeSelector: { disktype: ssd-nonexistent }
  containers:
  - name: c
    image: busybox
    command: ["sh","-c","sleep 3600"]
    resources: { limits: { nvidia.com/gpu: "1" } }
EOF
kubectl describe pod l4-bad-affinity | sed -n '/Events:/,$p'
```

```
Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  5s    default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 node(s) didn't match Pod's node affinity/selector. …
```

清掉它们，进入最后一种原因：

```bash
kubectl delete pod l4-too-big l4-bad-affinity
```

**原因 L3——争用。** 两张 GPU 都是真实的、`Ready` 的、空闲的。给两张 GPU 提交三个各要 1 张 GPU 的 Pod：

```bash
for p in trn-a trn-b trn-c; do
  kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata: { name: $p }
spec:
  containers:
  - name: c
    image: busybox
    command: ["sh","-c","sleep 3600"]
    resources: { limits: { nvidia.com/gpu: "1" } }
EOF
done
kubectl get pods -o wide
kubectl describe pod trn-c | sed -n '/Events:/,$p'
```

```
NAME    READY   STATUS    RESTARTS   AGE   NODE
trn-a   1/1     Running   0          12s   pending-worker2
trn-b   1/1     Running   0          12s   pending-worker
trn-c   0/1     Pending   0          12s   <none>

Events:
  Type     Reason            Age   From               Message
  ----     ------            ----  ----               -------
  Warning  FailedScheduling  11s   default-scheduler  0/3 nodes are available: 1 node(s) had untolerated taint(s), 2 Insufficient nvidia.com/gpu. …
```

把两个输出放在一起读，因为这里最容易让人犯迷糊：

- `kubectl get pods -o wide` 是**结果**：`trn-a` 和 `trn-b` 各抢到一张 GPU，正在 `Running`；只有 `trn-c` 是 `Pending`。调度并**没有**全盘失败——三个里有两个顺利落位了。
- 那个 `Events` 块来自 `describe pod trn-c`——是调度器在解释它为什么放不下**`trn-c` 这一个 Pod**。`0/3 nodes are available` 的意思是：*对这一个 Pod 来说*，三个节点没一个行：control-plane 被它的 role taint 挡在门外，而两个 worker 各自那张 GPU 已经被 `trn-a`/`trn-b` 占了。一个 Pod 会独占一整张 GPU——原生 Kubernetes 不会把一张 GPU 拆给多个 Pod 用（那需要 MIG / MPS / time-slicing，后面会讲）——所以两个 Pod 填满两张 GPU，第三个就没地方去了。

再注意这一行：`2 Insufficient nvidia.com/gpu`——和 L1 在完全没有 GPU 时*一模一样*。唯一能区分它们的就是 `get pods`：这里 GPU 存在且在忙；在 L1 里它们根本不存在。

```bash
kind delete cluster --name pending     # 清理
```

**刚才你按排查顺序看到的：**

| 原因 | 我们做了什么 | 调度器说了什么 |
|------|--------------|----------------|
| **L1** 没有池 | 提交要 1 卡的 Pod，任何地方都没 GPU | `2 Insufficient nvidia.com/gpu` |
| **L2** 节点不可调度 | `cordon` 掉有 GPU 的节点 | `2 node(s) were unschedulable` |
| **L4** 不可能的请求 | 要 8 张 GPU / 错误 selector（空闲集群） | `2 Insufficient nvidia.com/gpu` / `didn't match Pod's node affinity/selector` |
| **L3** 争用 | 3 个各要 1 卡的 Pod，2 张 GPU，都在忙 | `2 Insufficient nvidia.com/gpu` |

四种里有三种打印了同一行 `Insufficient nvidia.com/gpu`。这条消息告诉你调度器放不下这个 Pod——但它*不*告诉你为什么。排查树才告诉你：每层一个只读的 `get nodes` / `get pods -o wide` 问题，就能把这条消息混在一起的几种原因分开。

## 它给你换来了什么：计费表从不停

GPU 容量是按小时计费的，无论上面有没有东西在跑。一个预留池——哪怕只是一张高端加速卡——在 0% 占用时和在满载时，每小时花的钱是一样的；空闲时间就是你已经承诺出去、却什么都没换回来的钱。所以一个 `Pending` Pod 真正的代价不是那个卡住的任务，而是它下面那块容量——在你每一分钟猜「为什么」的时候，都在空转、什么都不产出。

这就是一套结构化排查真正换来的东西：它缩短了那段「计费表在跑」的时间，*同时*让你不至于花两遍钱。调试 `Pending` 最贵的方式就是去猜是哪一层。把 L3（GPU 在忙）当成 L1（没有 GPU）——很容易，因为它们打印同一行——于是你「修」它的办法是去买你本来就已经有的容量，结果你现在为两个空闲的池付钱，而不是一个。把 L1 当成 L3，你会花一下午去调一个根本不是瓶颈的调度器，而那个预留池还在一直烧钱。一套定义清晰的四问流程，能把「出事了，把所有人都叫来」变成「是 L2，节点被 cordon 了」，用时不到一分钟——而这一分钟之所以重要，正是因为你思考的时候账单不会暂停。

这正是 [0.1](/zh/blog/four-layer-capacity-model) 里那道**接缝**露出獠牙的地方：一个付了钱的预留可以卡在 L1 的 `Pending`——在计费、却从没被变成一个可调度的节点——与此同时，容量团队的看板说「active，$X/小时」，平台团队的看板说「N 个 Pod Pending」，而*没有任何一块*看板显示中间那些空转的钱。在动任何东西之前，用一分钟说清楚到底是哪一层卡住、而不是吵一个小时，是你手上最便宜的省钱动作。

## 小结

`Pending` 是四个问题套着同一个词——没有池（L1）、没有就绪节点（L2）、不可能的请求（L4）、或者单纯的争用（L3）——而调度器的消息常常分不清它们。按顺序走这棵树，在每一层问那一个便宜的问题，你就能在花钱去修错的地方之前，先知道自己到底碰上了哪一种。后面的文章会逐层深入下去。

---

*这是一个个人博客——观点仅代表我个人，不代表我的雇主；文中所有内容均基于公开文档化的特性。*
